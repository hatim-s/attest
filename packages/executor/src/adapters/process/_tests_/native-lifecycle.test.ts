import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Cause from 'effect/Cause';
import * as Fiber from 'effect/Fiber';
import * as Deferred from 'effect/Deferred';
import * as Scope from 'effect/Scope';
import { createServer, type Socket } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_PROTOCOL,
  AGENT_RESOURCE_SCHEMA_ID,
  isString,
  type AgentRequest,
} from '@attest/contracts';
import { startJsonlBridgeAgent, type JsonlBridgeAgentResource } from '../jsonl-bridge-adapter.js';
import { ProcessCleanupError } from '../process-cleanup.js';
import { ManagedChild } from '../managed-child.js';
import { startBackgroundAgent, type BackgroundAgentResource } from '../background-adapter.js';
import { waitForReadiness } from '../background-readiness.js';
import { AgentInvocationError } from '../../../errors.js';
import { startLoopbackServer } from '../../../_tests_/support/loopback-server.js';

const agent: JsonlBridgeAgentResource = {
  schema: AGENT_RESOURCE_SCHEMA_ID,
  id: 'native',
  name: 'Native',
  transport: {
    kind: 'jsonl_bridge',
    lifecycle: 'per_run',
    concurrency: 'multiplexed',
    argv: [
      process.execPath,
      resolve(import.meta.dirname, '../../../_tests_/fixtures/jsonl-bridge-agent.cjs'),
    ],
    cancellation_grace_ms: 100,
  },
  timeouts: { attempt_ms: 2000 },
};

const request = (caseId: string, delay: number): AgentRequest => ({
  protocol: AGENT_PROTOCOL,
  run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  case_id: caseId,
  input: { delay_ms: delay, value: caseId },
});

describe('native process ownership', () => {
  it('retains background cleanup after its first close observer is interrupted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'attest-background-close-'));
    await writeFile(join(directory, 'ps'), '#!/bin/sh\nexit 2\n', { mode: 0o755 });
    const entered = Deferred.makeUnsafe<void>();
    let finishShutdown: (() => void) | undefined;
    let shutdownCalls = 0;

    const server = await startLoopbackServer((_request, response) => {
      shutdownCalls++;
      finishShutdown = () => {
        if (!response.writableEnded) response.writeHead(204).end();
      };

      Deferred.doneUnsafe(entered, Effect.void);
    });

    const configured: BackgroundAgentResource = {
      schema: AGENT_RESOURCE_SCHEMA_ID,
      id: 'background',
      name: 'Background',
      transport: {
        kind: 'background_cli',
        lifecycle: 'per_run',
        start_argv: [
          process.execPath,
          '-e',
          "process.stderr.write('READY\\n'); setInterval(() => {}, 1000)",
        ],
        readiness: { kind: 'stderr', pattern: 'READY' },
        invoke: { method: 'POST', url: server.url + '/invoke', body: '{{request}}' },
        extraction: { result_pointer: '/output' },
        shutdown: { method: 'POST', url: server.url + '/shutdown' },
        stop_timeout_ms: 500,
      },
      timeouts: { connect_ms: 2000 },
    };

    try {
      vi.stubEnv('PATH', directory);
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* startBackgroundAgent(configured, { cwd: directory, env: {} });
            const closing = yield* session.close().pipe(Effect.forkChild);
            yield* Deferred.await(entered);
            const interrupting = yield* Fiber.interrupt(closing).pipe(Effect.forkChild);
            yield* Effect.sleep(1);
            finishShutdown?.();
            yield* Fiber.join(interrupting);
            const count = session.cleanupExits.length;
            const first = yield* Effect.exit(session.close());
            const second = yield* Effect.exit(session.close());
            expect(session.cleanupExits).toHaveLength(count);
            expect(shutdownCalls).toBe(1);

            if (Exit.isSuccess(first) || Exit.isSuccess(second))
              throw new Error('Expected cleanup failure');
            const failure = Cause.squash(first.cause);
            expect(failure).toBeInstanceOf(ProcessCleanupError);
            expect(Cause.squash(second.cause)).toBe(failure);
          }),
        ),
      );
      expect(shutdownCalls).toBe(1);
    } finally {
      finishShutdown?.();
      vi.unstubAllEnvs();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('detaches the winning stderr readiness listener', async () => {
    await Effect.runPromise(
      Effect.acquireUseRelease(
        ManagedChild.start({
          argv: [
            process.execPath,
            '-e',
            "process.stdin.once('data', () => process.stderr.write('READY\\n')); setInterval(() => {}, 1000)",
          ],
          cwd: process.cwd(),
          env: {},
          stderrCapBytes: 100,
        }),
        (child) =>
          Effect.gen(function* () {
            const cleanupExits: Exit.Exit<unknown, unknown>[] = [];
            const initial = child.stderr.listenerCount('data');

            const observing = yield* waitForReadiness(
              { kind: 'stderr', pattern: 'READY' },
              {
                process: child,
                cleanupExits,
                signal: AbortSignal.timeout(2000),
                abortError: () =>
                  new AgentInvocationError('timeout', 'Readiness fixture timed out'),
              },
            ).pipe(Effect.forkChild);

            while (child.stderr.listenerCount('data') === initial) yield* Effect.yieldNow;
            yield* child.writeLine({ type: 'cancel', request_id: 'ready' });
            yield* Fiber.join(observing);
            expect(child.stderr.listenerCount('data')).toBe(initial);
            expect(cleanupExits.length).toBeGreaterThanOrEqual(2);
            expect(cleanupExits.every(Exit.isSuccess)).toBe(true);
          }),
        (child) => Effect.asVoid(Effect.exit(child.terminate(0))),
      ),
    );
  });

  it('closes the winning TCP readiness socket before keeping the session alive', async () => {
    const sockets = new Set<Socket>();
    let acknowledgeClose: (() => void) | undefined;

    const closed = new Promise<void>((resolve) => {
      acknowledgeClose = resolve;
    });

    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => {
        sockets.delete(socket);
        acknowledgeClose?.();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();

    if (address === null || isString(address)) throw new Error('Expected TCP address');
    let timer: NodeJS.Timeout | undefined;

    try {
      await Effect.runPromise(
        Effect.acquireUseRelease(
          ManagedChild.start({
            argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
            cwd: process.cwd(),
            env: {},
            stderrCapBytes: 100,
          }),
          (child) =>
            Effect.gen(function* () {
              const cleanupExits: Exit.Exit<unknown, unknown>[] = [];
              yield* waitForReadiness(
                { kind: 'tcp', host: '127.0.0.1', port: address.port },
                {
                  process: child,
                  cleanupExits,
                  signal: AbortSignal.timeout(2000),
                  abortError: () =>
                    new AgentInvocationError('timeout', 'Readiness fixture timed out'),
                },
              );

              const released = yield* Effect.promise(() =>
                Promise.race([
                  closed.then(() => true),
                  new Promise<boolean>((resolve) => {
                    timer = setTimeout(() => resolve(false), 500);
                  }),
                ]),
              );

              expect(released).toBe(true);
              expect(cleanupExits.length).toBeGreaterThanOrEqual(2);
            }),
          (child) => Effect.asVoid(Effect.exit(child.terminate(0))),
        ),
      );
    } finally {
      clearTimeout(timer);

      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([
    ['sequential', false],
    ['parallel', false],
    ['parallel', true],
  ] as const)(
    'settles JSONL fallback cleanup in a %s scope with unavailable observations %s',
    async (strategy, unavailable) => {
      const directory = await mkdtemp(join(tmpdir(), 'attest-jsonl-scope-'));
      let timer: NodeJS.Timeout | undefined;

      try {
        if (unavailable) {
          await writeFile(join(directory, 'ps'), '#!/bin/sh\nexit 2\n', { mode: 0o755 });
          vi.stubEnv('PATH', directory);
        }

        const scope = await Effect.runPromise(Scope.make(strategy));

        const session = await Effect.runPromise(
          Scope.provide(scope)(
            startJsonlBridgeAgent(
              {
                ...agent,
                transport: {
                  ...agent.transport,
                  argv: [process.execPath, '-e', 'setTimeout(() => process.exit(0), 1000)'],
                },
              },
              { cwd: process.cwd(), env: {}, terminationGraceMs: 0 },
            ),
          ),
        );

        const settled = await Promise.race([
          Effect.runPromise(Scope.close(scope, Exit.void)).then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), 2500);
          }),
        ]);

        expect(settled).toBe(true);
        const first = await Effect.runPromiseExit(session.close());
        const second = await Effect.runPromiseExit(session.close());
        expect(second).toEqual(first);
        expect(session.cleanupExits).toHaveLength(4);
        expect(session.cleanupExits.every(Exit.isSuccess)).toBe(!unavailable);

        if (unavailable) {
          if (Exit.isSuccess(first) || Exit.isSuccess(second))
            throw new Error('Expected cleanup failure');
          expect(Cause.squash(first.cause)).toBeInstanceOf(ProcessCleanupError);
          expect(Cause.squash(second.cause)).toBe(Cause.squash(first.cause));
        }
      } finally {
        clearTimeout(timer);
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
  it('joins interrupted JSONL cancellation without interrupting another request', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* startJsonlBridgeAgent(agent, {
            cwd: process.cwd(),
            env: { PATH: process.env.PATH ?? '' },
            terminationGraceMs: 20,
          });

          const slow = yield* session.invoke(request('slow', 500)).pipe(Effect.forkChild);
          const fast = yield* session.invoke(request('fast', 5)).pipe(Effect.forkChild);
          yield* Effect.sleep(10);
          yield* Fiber.interrupt(slow);
          const interrupted = yield* Fiber.await(slow);
          expect(Exit.isFailure(interrupted) && Cause.hasInterrupts(interrupted.cause)).toBe(true);
          expect((yield* Fiber.join(fast)).status).toBe('ok');
          // A confirmed in-band acknowledgement leaves the bridge usable.
          expect((yield* session.invoke(request('after', 0))).status).toBe('ok');
          yield* session.close();
        }),
      ),
    );
  });

  it('joins fallback before returning interruption when the peer refuses acknowledgement', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* startJsonlBridgeAgent(agent, {
            cwd: process.cwd(),
            env: { PATH: process.env.PATH ?? '', IGNORE_CANCEL: '1' },
            terminationGraceMs: 0,
          });

          const requestFiber = yield* session
            .invoke(request('refuses', 500))
            .pipe(Effect.forkChild);

          yield* Effect.sleep(10);
          yield* Fiber.interrupt(requestFiber);
          // The cancellation grace expired and admission stopped before the observer was released.
          expect((yield* session.invoke(request('after-fallback', 0))).status).toBe(
            'invocation_error',
          );
          yield* session.close();
        }),
      ),
    );
  });

  it('retains completed evidence and the same failed cleanup Exit on repeated close', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'attest-native-cleanup-'));
    await writeFile(join(directory, 'ps'), '#!/bin/sh\nexit 2\n', { mode: 0o755 });

    try {
      vi.stubEnv('PATH', directory);
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* startJsonlBridgeAgent(agent, {
              cwd: directory,
              env: { PATH: directory },
              terminationGraceMs: 0,
            });

            const completed = yield* session.invoke(request('evidence', 0));
            expect(completed.status).toBe('ok');
            const first = yield* Effect.exit(session.close());
            const second = yield* Effect.exit(session.close());

            if (Exit.isSuccess(first) || Exit.isSuccess(second))
              throw new Error('Expected unconfirmed cleanup');
            const failure = Cause.squash(first.cause);
            expect(failure).toBeInstanceOf(ProcessCleanupError);

            if (!(failure instanceof ProcessCleanupError))
              throw new Error('Expected process cleanup evidence');
            expect(failure.completed).toBe(completed);
            expect(failure.exits.some((exit) => Exit.isFailure(exit))).toBe(true);
            expect(Cause.squash(second.cause)).toBe(failure);
            expect((yield* session.invoke(request('refused', 0))).status).toBe('invocation_error');
          }),
        ),
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it.each(['split', 'cap'] as const)(
  'preserves UTF-8 framing and bounded output for %s',
  async (mode) => {
    const source = `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).once('line', (line) => {
      const { request_id } = JSON.parse(line);
      const frame = Buffer.from(JSON.stringify({ type: 'response', request_id, response: { protocol: 'attest.agent-invocation', output: '😀' } }) + '\\n');
      const index = frame.indexOf(Buffer.from('😀')) + 1;
      process.stdout.write(frame.subarray(0, index));
      setTimeout(() => process.stdout.write(frame.subarray(index)), 5);
    });
    setInterval(() => {}, 1000);
  `;

    const configured: JsonlBridgeAgentResource = {
      ...agent,
      transport: { ...agent.transport, argv: [process.execPath, '-e', source] },
      limits: mode === 'cap' ? { event_bytes: 32 } : undefined,
    };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* startJsonlBridgeAgent(configured, {
            cwd: process.cwd(),
            env: {},
            terminationGraceMs: 0,
          });

          const result = yield* session.invoke(request(mode, 0));

          if (mode === 'cap')
            expect(result).toMatchObject({
              status: 'invocation_error',
              error: { code: 'output_cap_exceeded' },
            });
          else {
            expect(result.status).toBe('ok');

            if (result.status === 'ok') expect(result.raw).toMatchObject({ output: '😀' });
          }

          yield* session.close();
        }),
      ),
    );
  },
);
