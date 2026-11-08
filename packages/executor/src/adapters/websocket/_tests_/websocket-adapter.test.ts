import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import { createServer, type AddressInfo } from 'node:net';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Scope from 'effect/Scope';
import * as Fiber from 'effect/Fiber';
import { Duplex } from 'node:stream';
import { getEventListeners } from 'node:events';
import { WebSocketConnection } from '../websocket-connection.js';
import { PerCaseWebSocketSession } from '../per-case-session.js';
import { RunScopedWebSocketSession } from '../run-scoped-session.js';
import {
  AGENT_PROTOCOL,
  AGENT_RESOURCE_SCHEMA_ID,
  type AgentRequest,
  type WebSocketAttemptEvidence,
} from '@attest/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  startWebSocketAgent as acquireWebSocketAgent,
  type WebSocketAgentResource,
} from '../websocket-adapter.js';
import {
  WebSocketCleanupError,
  withWebSocketRelease,
  WebSocketCleanup,
} from '../websocket-lifetime.js';
import { WebSocketSessionState } from '../websocket-session-state.js';
import { AgentInvocationError } from '../../../errors.js';
import { startTestWebSocketServer } from './support/test-websocket-server.js';

/** Runs native test operations while preserving the original typed failure. */
const run = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect);

  if (Exit.isSuccess(exit)) return exit.value;

  for (const reason of exit.cause.reasons) {
    if (reason._tag === 'Fail' && reason.error instanceof Error) throw reason.error;
  }

  throw new Error('Native operation failed.', { cause: exit.cause });
};

/** Holds one native session scope across the foreign test callback. */
const startWebSocketAgent = async (...args: Parameters<typeof acquireWebSocketAgent>) => {
  const scope = await run(Scope.make());
  const session = await run(Scope.provide(acquireWebSocketAgent(...args), scope));

  return {
    invoke: (...invocation: Parameters<typeof session.invoke>) =>
      run(session.invoke(...invocation)),
    close: async () => {
      try {
        await run(session.close());
      } finally {
        await run(Scope.close(scope, Exit.void));
      }
    },
  };
};

type Fixture = Awaited<ReturnType<typeof startTestWebSocketServer>>;

const fixtures: Fixture[] = [];

const request = (caseId: string, input: AgentRequest['input']): AgentRequest => ({
  protocol: AGENT_PROTOCOL,
  run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  case_id: caseId,
  input,
});

const agent = (
  url: string,
  overrides: Partial<WebSocketAgentResource> = {},
): WebSocketAgentResource => ({
  schema: AGENT_RESOURCE_SCHEMA_ID,
  id: 'websocket-agent',
  name: 'WebSocket agent',
  transport: {
    kind: 'websocket',
    lifecycle: 'per_run',
    connection_mode: 'multiplexed',
    framing: 'text_json',
    url,
    request_template: { type: 'invoke', request_id: '{{request_id}}' },
    request_id_pointer: '/request_id',
    acknowledgement_pointer: '/ack',
    acknowledgement_values: [true],
    result_pointer: '/result',
    error_pointer: '/error',
    trace_pointer: '/trace',
    open_timeout_ms: 200,
    message_idle_timeout_ms: 200,
    attempt_timeout_ms: 500,
    ping_interval_ms: 25,
    close_timeout_ms: 100,
    retry_boundary: 'before_acknowledgement',
    replay_after_acknowledgement: false,
  },
  ...overrides,
});

/** Reads evidence emitted by the typed WebSocket evidence recorder. */
// SAFETY: the recorder constructs WebSocketAttemptEvidence and serializes it into rawExcerpt.
const evidence = (value: { rawExcerpt?: { text: string } }): WebSocketAttemptEvidence =>
  JSON.parse(value.rawExcerpt?.text ?? '{}') as WebSocketAttemptEvidence;

const failureClassification = (value: { rawExcerpt?: { text: string } }): string | undefined => {
  const parsed = evidence(value);

  return parsed.outcome === 'completed' ? undefined : parsed.error_classification;
};

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe('WebSocket adapter', () => {
  it('keeps invalid auth configuration in the typed error channel', async () => {
    const url = 'ws://127.0.0.1:1/invoke';

    const configured = agent(url, {
      transport: { ...agent(url).transport, headers: { Host: 'overridden' } },
    });

    await expect(startWebSocketAgent(configured)).rejects.toMatchObject({
      code: 'invalid_envelope',
    });
  });

  it('records an oversized outbound request without dispatch or replay', async () => {
    let deliveries = 0;

    const fixture = await startTestWebSocketServer({
      onMessage: () => {
        deliveries++;
      },
    });

    fixtures.push(fixture);

    const session = await startWebSocketAgent(
      agent(fixture.url, {
        limits: { request_bytes: 1 },
        retry: { retries: 2, backoff: { kind: 'none' } },
      }),
    );

    try {
      const result = await session.invoke(request('too-large', 'x'.repeat(100)));
      expect(result.status).toBe('invocation_error');

      if (result.status !== 'invocation_error') throw new Error('Expected request cap failure.');
      expect(result.error.code).toBe('output_cap_exceeded');
      expect(result.attempts).toHaveLength(1);
      expect(deliveries).toBe(0);
    } finally {
      await session.close();
    }
  });

  it('correlates multiplexed results, extracts traces, redacts evidence, and resolves headers', async () => {
    let observedAuthorization: string | undefined;

    const fixture = await startTestWebSocketServer({
      subprotocol: 'attest-json',
      onConnection: (_peer, upgrade) => {
        observedAuthorization = upgrade.headers.authorization;
      },
      onMessage: (peer, raw) => {
        const message = raw;

        if (message.request.case_id === 'error') {
          peer.sendJson({
            request_id: message.request_id,
            ack: true,
            error: { code: 'refused', message: 'remote refusal' },
          });

          return;
        }

        const delay = message.request.case_id === 'slow' ? 30 : 1;
        setTimeout(
          () =>
            peer.sendJson({
              request_id: message.request_id,
              ack: true,
              result: message.request.input,
              trace: { schema: 'attest.trace', spans: [] },
              secret: 'transport-secret',
            }),
          delay,
        );
      },
    });

    fixtures.push(fixture);

    const configured = agent(fixture.url, {
      transport: {
        ...agent(fixture.url).transport,
        headers: { Authorization: { from_env: 'AGENT_TOKEN' } },
        subprotocol: 'attest-json',
      },
      redaction: { event_pointers: ['/secret'] },
    });

    const session = await startWebSocketAgent(configured, {
      headers: { Authorization: 'Bearer transport-secret' },
      secrets: ['transport-secret'],
    });

    try {
      const [slow, fast, remoteError] = await Promise.all([
        session.invoke(request('slow', { value: 'slow' })),
        session.invoke(request('fast', { value: 'fast' })),
        session.invoke(request('error', null)),
      ]);

      expect(slow.status).toBe('ok');
      expect(fast.status).toBe('ok');

      if (slow.status === 'ok' && slow.report?.ok && 'output' in slow.report.value) {
        expect(slow.report.value.output).toEqual({ value: 'slow' });
      }

      expect(observedAuthorization).toBe('Bearer transport-secret');
      expect(remoteError.status).toBe('ok');

      if (remoteError.status === 'ok' && remoteError.report?.ok) {
        expect(remoteError.report.value).toMatchObject({
          error: { code: 'refused', message: 'remote refusal' },
        });
      }

      expect(fast.rawExcerpt?.text).not.toContain('transport-secret');
      expect(fast.rawExcerpt?.text).toContain('[REDACTED]');
      expect(evidence(fast).acknowledgement.state).toBe('acknowledged');
    } finally {
      await session.close();
    }
  });

  it('serializes run-scoped serial work and opens one connection per per-case invocation', async () => {
    let inFlight = 0;
    let maximumInFlight = 0;

    const fixture = await startTestWebSocketServer({
      onMessage: (peer, raw) => {
        const message = raw;
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        setTimeout(() => {
          inFlight -= 1;
          peer.sendJson({ request_id: message.request_id, ack: true, result: 'done' });
        }, 15);
      },
    });

    fixtures.push(fixture);

    const serial = await startWebSocketAgent(
      agent(fixture.url, {
        transport: { ...agent(fixture.url).transport, connection_mode: 'serial' },
      }),
    );

    await Promise.all([serial.invoke(request('one', 'one')), serial.invoke(request('two', 'two'))]);
    expect(maximumInFlight).toBe(1);
    expect(fixture.connectionCount()).toBe(1);
    await serial.close();

    const perCase = await startWebSocketAgent(
      agent(fixture.url, {
        transport: {
          ...agent(fixture.url).transport,
          lifecycle: 'per_case',
          connection_mode: 'serial',
        },
      }),
    );

    await Promise.all([
      perCase.invoke(request('three', 'three')),
      perCase.invoke(request('four', 'four')),
    ]);
    expect(fixture.connectionCount()).toBe(3);
    await perCase.close();
  });

  it('cancels one multiplexed request without disturbing another or treating its late result as work', async () => {
    const fixture = await startTestWebSocketServer({
      onMessage: (peer, raw) => {
        const message = raw;
        const delay = message.request.case_id === 'cancel' ? 50 : 10;
        setTimeout(
          () => peer.sendJson({ request_id: message.request_id, ack: true, result: 'done' }),
          delay,
        );
      },
    });

    fixtures.push(fixture);
    const session = await startWebSocketAgent(agent(fixture.url));
    const controller = new AbortController();

    try {
      const cancelled = session.invoke(request('cancel', null), controller.signal);
      const kept = session.invoke(request('keep', null));
      setTimeout(() => controller.abort(), 5);
      const [cancelledResult, keptResult] = await Promise.all([cancelled, kept]);
      expect(cancelledResult.status).toBe('invocation_error');

      if (cancelledResult.status === 'invocation_error') {
        expect(cancelledResult.error.code).toBe('cancelled');
      }

      expect(keptResult.status).toBe('ok');
      await new Promise((resolve) => setTimeout(resolve, 60));
    } finally {
      await session.close();
    }
  });

  it('never replays unknown dispatch before or after acknowledgement', async () => {
    const deliveries = new Map<string, number>();

    const fixture = await startTestWebSocketServer({
      onMessage: (peer, raw) => {
        const message = raw;
        const count = (deliveries.get(message.request.case_id) ?? 0) + 1;
        deliveries.set(message.request.case_id, count);

        if (message.request.case_id === 'before-ack' && count === 1) {
          peer.drop();

          return;
        }

        if (message.request.case_id === 'after-ack') {
          peer.sendJson({ request_id: message.request_id, ack: true });
          setTimeout(() => peer.drop(), 2);

          return;
        }

        peer.sendJson({ request_id: message.request_id, ack: true, result: 'replayed' });
      },
    });

    fixtures.push(fixture);

    const session = await startWebSocketAgent(
      agent(fixture.url, { retry: { retries: 1, backoff: { kind: 'none' } } }),
    );

    try {
      const replayed = await session.invoke(request('before-ack', null));
      expect(replayed.status).toBe('invocation_error');
      expect(replayed.attempts).toHaveLength(1);
      expect(deliveries.get('before-ack')).toBe(1);

      if (replayed.status === 'invocation_error')
        expect(replayed.error.applicationStarted).toBe(true);

      const failed = await session.invoke(request('after-ack', null));
      expect(failed.status).toBe('invocation_error');
      expect(failed.attempts).toHaveLength(1);
      expect(deliveries.get('after-ack')).toBe(1);
      expect(evidence(failed).acknowledgement.state).toBe('acknowledged');
    } finally {
      await session.close().catch(() => undefined);
    }
  });

  it.each(['per_run', 'per_case'] as const)(
    'retains each known pre-dispatch failure for %s retries',
    async (lifecycle) => {
      const listener = createServer();
      await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
      // SAFETY: listening on a numeric TCP port and IPv4 host returns AddressInfo.
      const address = listener.address() as AddressInfo;
      const url = `ws://127.0.0.1:${address.port}/invoke`;
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error === undefined ? resolve() : reject(error))),
      );

      const session = await startWebSocketAgent(
        agent(url, {
          transport: { ...agent(url).transport, lifecycle, connection_mode: 'serial' },
          retry: { retries: 1, backoff: { kind: 'none' } },
        }),
      );

      try {
        const result = await session.invoke(request('refused', null));
        expect(result.status).toBe('invocation_error');
        expect(result.attempts).toHaveLength(2);

        for (const attempt of result.attempts) {
          expect(
            evidence(attempt).events.some((event) => event.classification === 'request_sent'),
          ).toBe(false);
          expect(evidence(attempt).acknowledgement.state).toBe('not_acknowledged');
        }
      } finally {
        await session.close();
      }
    },
  );

  it('keeps protocol pings separate from application-idle timeout', async () => {
    const fixture = await startTestWebSocketServer({ onMessage: () => undefined });
    fixtures.push(fixture);

    const session = await startWebSocketAgent(
      agent(fixture.url, {
        transport: {
          ...agent(fixture.url).transport,
          open_timeout_ms: 50,
          ping_interval_ms: 5,
          message_idle_timeout_ms: 30,
          attempt_timeout_ms: 100,
        },
      }),
    );

    try {
      const result = await session.invoke(request('idle', null));
      expect(result.status).toBe('invocation_error');

      if (result.status === 'invocation_error') expect(result.error.code).toBe('timeout');
      expect(failureClassification(result)).toBe('message_idle_timeout');
      expect(fixture.peers[0]?.pingCount).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });

  it('enforces distinct open and total-attempt deadlines', async () => {
    const blackhole = await startTestWebSocketServer({
      ignoreUpgrade: true,
      onMessage: () => undefined,
    });

    fixtures.push(blackhole);

    const opening = await startWebSocketAgent(
      agent(blackhole.url, {
        transport: {
          ...agent(blackhole.url).transport,
          open_timeout_ms: 20,
          message_idle_timeout_ms: 80,
          attempt_timeout_ms: 100,
          ping_interval_ms: 10,
        },
      }),
    );

    const openResult = await opening.invoke(request('open-timeout', null));
    expect(openResult.status).toBe('invocation_error');
    expect(failureClassification(openResult)).toBe('open_timeout');
    await opening.close();

    const intervals: NodeJS.Timeout[] = [];

    const acknowledging = await startTestWebSocketServer({
      onMessage: (peer, raw) => {
        const message = raw;
        peer.sendJson({ request_id: message.request_id, ack: true });
        intervals.push(
          setInterval(() => peer.sendJson({ request_id: message.request_id, ack: true }), 15),
        );
      },
    });

    fixtures.push(acknowledging);

    const attempting = await startWebSocketAgent(
      agent(acknowledging.url, {
        transport: {
          ...agent(acknowledging.url).transport,
          open_timeout_ms: 20,
          message_idle_timeout_ms: 40,
          attempt_timeout_ms: 80,
          ping_interval_ms: 10,
        },
      }),
    );

    const attemptResult = await attempting.invoke(request('attempt-timeout', null));

    for (const interval of intervals) clearInterval(interval);
    expect(attemptResult.status).toBe('invocation_error');
    expect(failureClassification(attemptResult)).toBe('attempt_timeout');
    await attempting.close();
  });

  it.each([
    [
      'binary frames',
      (peer: Fixture['peers'][number]) => peer.sendBinary(),
      'binary_frame_unsupported',
    ],
    [
      'uncorrelated work',
      (peer: Fixture['peers'][number]) => peer.sendJson({ request_id: 'unknown', ack: true }),
      'uncorrelated_server_work',
    ],
    ['invalid JSON', (peer: Fixture['peers'][number]) => peer.sendText('{'), 'invalid_json'],
  ] as const)('rejects %s and fails outstanding work', async (_name, hostile, classification) => {
    const fixture = await startTestWebSocketServer({
      onMessage: (peer) => hostile(peer),
    });

    fixtures.push(fixture);
    const session = await startWebSocketAgent(agent(fixture.url));

    try {
      const result = await session.invoke(request('hostile', null));
      expect(result.status).toBe('invocation_error');
      expect(failureClassification(result)).toBe(classification);
    } finally {
      await session.close().catch(() => undefined);
    }
  });

  it('classifies an uncooperative per-case close handshake as a close timeout', async () => {
    const fixture = await startTestWebSocketServer({
      ignoreClientClose: true,
      onMessage: (peer, raw) => {
        const message = raw;
        peer.sendJson({ request_id: message.request_id, ack: true, result: 'done' });
      },
    });

    fixtures.push(fixture);

    const configured = agent(fixture.url, {
      retry: { retries: 1, backoff: { kind: 'none' } },
      transport: {
        ...agent(fixture.url).transport,
        lifecycle: 'per_case',
        connection_mode: 'serial',
        close_timeout_ms: 20,
      },
    });

    vi.spyOn(WebSocketSessionState.prototype, 'openConnection').mockReturnValueOnce(
      Effect.fail(new AgentInvocationError('network', 'Known refused open.')),
    );
    const session = await startWebSocketAgent(configured);

    const result = await session
      .invoke(request('close-timeout', null))
      .catch((error: Error) => error);

    expect(result).toBeInstanceOf(WebSocketCleanupError);

    if (!(result instanceof WebSocketCleanupError)) throw new Error('Expected cleanup evidence.');
    expect(result.classification).toBe('close_timeout');
    expect(result.result.status).toBe('ok');
    expect(result.result.attempts).toHaveLength(2);
    expect(result.result.attempts[0]).toMatchObject({
      status: 'invocation_error',
      error: { message: 'Known refused open.' },
    });
    expect(evidence(result.result).outcome).toBe('completed');
    await session.close();
  });

  it('cancels a delayed per-case open before a closed session can send', async () => {
    let messages = 0;

    const fixture = await startTestWebSocketServer({
      upgradeDelayMs: 80,
      onMessage: () => {
        messages += 1;
      },
    });

    fixtures.push(fixture);

    const session = await startWebSocketAgent(
      agent(fixture.url, {
        transport: {
          ...agent(fixture.url).transport,
          lifecycle: 'per_case',
          connection_mode: 'serial',
        },
      }),
    );

    let joined = false;

    const invocation = session.invoke(request('closed-during-open', null)).then((result) => {
      joined = true;

      return result;
    });

    await vi.waitFor(() => expect(fixture.upgradeRequests()).toBe(1));
    await session.close();
    expect(joined).toBe(true);
    const result = await invocation;
    expect(result.status).toBe('invocation_error');
    expect(failureClassification(result)).toBe('cancelled');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(messages).toBe(0);
  });

  it('fails a message larger than the event byte cap', async () => {
    const fixture = await startTestWebSocketServer({
      onMessage: (peer, raw) => {
        const message = raw;
        peer.sendJson({ request_id: message.request_id, ack: true, result: 'x'.repeat(2_000) });
      },
    });

    fixtures.push(fixture);

    const session = await startWebSocketAgent(
      agent(fixture.url, { limits: { event_bytes: 1_024 } }),
    );

    try {
      const result = await session.invoke(request('oversized', null));
      expect(result.status).toBe('invocation_error');

      if (result.status === 'invocation_error') {
        expect(result.error.code).toBe('output_cap_exceeded');
      }
    } finally {
      await session.close().catch(() => undefined);
    }
  });

  it('redacts secrets nested in result and trace evidence', async () => {
    const secret = 'fixture-websocket-secret-never-persist';

    const fixture = await startTestWebSocketServer({
      onMessage: (peer, raw) => {
        const message = raw;
        peer.sendJson({ request_id: message.request_id, ack: true });
        peer.sendJson({
          request_id: message.request_id,
          result: { authorization: `Bearer ${secret}`, nested: { api_key: secret } },
          trace: { token: secret },
        });
      },
    });

    fixtures.push(fixture);
    const session = await startWebSocketAgent(agent(fixture.url), { secrets: [secret] });

    try {
      const result = await session.invoke(request('secret', null));
      expect(result.attempts.length).toBeGreaterThan(0);

      for (const attempt of result.attempts) {
        expect(attempt.rawExcerpt?.text).not.toContain(secret);
      }
    } finally {
      await session.close();
    }
  });

  it('rejects prohibited network targets', async () => {
    const prohibited = await startWebSocketAgent(agent('ws://192.168.1.10/invoke'));
    const prohibitedResult = await prohibited.invoke(request('private', null));
    expect(prohibitedResult.status).toBe('invocation_error');

    if (prohibitedResult.status === 'invocation_error') {
      expect(prohibitedResult.error.message).toContain('prohibited network address');
    }

    await prohibited.close();
  });
});

describe('WebSocket release precedence', () => {
  it('retains typed failures, defects and interruption when cleanup also fails', async () => {
    const primary = new AgentInvocationError('cancelled', 'primary');
    const cleanup = new Error('cleanup');

    const typed = await Effect.runPromiseExit(
      withWebSocketRelease(Effect.fail(primary), Effect.die(cleanup)),
    );

    expect(Exit.isFailure(typed)).toBe(true);

    if (Exit.isFailure(typed)) {
      expect(typed.cause.reasons[0]?._tag).toBe('Fail');
      expect(typed.cause.reasons[0]).toMatchObject({ error: primary });
      expect(Cause.hasDies(typed.cause)).toBe(false);
      const retained = Context.getOrUndefined(Cause.annotations(typed.cause), WebSocketCleanup);
      expect(retained).toHaveLength(1);
      expect(retained?.[0] && Cause.hasDies(retained[0])).toBe(true);
    }

    const defect = await Effect.runPromiseExit(
      withWebSocketRelease(Effect.die(primary), Effect.fail(cleanup)),
    );

    if (Exit.isSuccess(defect)) throw new Error('Expected defect.');
    expect(Cause.hasDies(defect.cause)).toBe(true);
    expect(defect.cause.reasons[0]).toMatchObject({ defect: primary });

    const interrupted = await Effect.runPromiseExit(
      withWebSocketRelease(Effect.interrupt, Effect.fail(cleanup)),
    );

    if (Exit.isSuccess(interrupted)) throw new Error('Expected interruption.');
    expect(Cause.hasInterrupts(interrupted.cause)).toBe(true);
  });

  it('retains successful evidence and captures cleanup defects after success', async () => {
    const completed = { retained: 'completed evidence' };

    const failure = await Effect.runPromiseExit(
      withWebSocketRelease(Effect.succeed(completed), Effect.die(new Error('release failed'))),
    );

    if (Exit.isSuccess(failure)) throw new Error('Expected failed release.');
    const reason = failure.cause.reasons[0];

    if (reason?._tag !== 'Fail') throw new Error('Expected typed cleanup failure.');
    expect(reason.error.cause).toMatchObject({ success: completed });
    expect(reason.error.applicationStarted).toBe(true);
  });
});

describe('WebSocket ownership under interruption and failed opening', () => {
  it.each(['multiplexed', 'serial'] as const)(
    'ignores native-interrupted replies while preserving %s siblings',
    async (connectionMode) => {
      const replies = new Map<string, () => void>();

      const fixture = await startTestWebSocketServer({
        onMessage: (peer, message) => {
          replies.set(message.request.case_id, () =>
            peer.sendJson({ request_id: message.request_id, ack: true, result: 'kept' }),
          );
        },
      });

      fixtures.push(fixture);
      const scope = await run(Scope.make());

      const session = await run(
        Scope.provide(
          acquireWebSocketAgent(
            agent(fixture.url, {
              transport: { ...agent(fixture.url).transport, connection_mode: connectionMode },
            }),
          ),
          scope,
        ),
      );

      try {
        const stopped = Effect.runFork(session.invoke(request('stopped', null)));
        await vi.waitFor(() => expect(replies.has('stopped')).toBe(true));
        const sibling = Effect.runPromiseExit(session.invoke(request('kept', null)));

        if (connectionMode === 'multiplexed')
          await vi.waitFor(() => expect(replies.has('kept')).toBe(true));
        stopped.interruptUnsafe();
        const stoppedExit = await run(Fiber.await(stopped));
        expect(Exit.isFailure(stoppedExit) && Cause.hasInterrupts(stoppedExit.cause)).toBe(true);
        await vi.waitFor(() => expect(replies.has('kept')).toBe(true));
        // Both frames use the same connection, so the abandoned reply is consumed first.
        replies.get('stopped')!();
        replies.get('kept')!();
        const kept = await sibling;

        if (Exit.isFailure(kept)) throw new Error('Sibling failed.', { cause: kept.cause });
        expect(kept.value.status).toBe('ok');
        expect(fixture.connectionCount()).toBe(1);
      } finally {
        await run(Scope.close(scope, Exit.void));
      }
    },
  );

  it.each(['per_case', 'per_run'] as const)(
    'keeps %s shared settlement errors and opening receipts separate',
    async (lifecycle) => {
      const cleanup = new Error('first opening release');
      const failures: AgentInvocationError[] = [];

      const observation = vi
        .spyOn(WebSocketSessionState.prototype, 'openConnection')
        .mockImplementation((signal) => {
          const first = failures.length === 0;

          const failure = new AgentInvocationError(
            'cancelled',
            first ? 'first open' : 'second open',
            {
              applicationStarted: first,
            },
          );

          failures.push(failure);

          const waitForClose = Effect.callback<void>((resume) => {
            const abort = (): void => resume(Effect.void);
            signal.addEventListener('abort', abort, { once: true });

            if (signal.aborted) abort();

            return Effect.sync(() => signal.removeEventListener('abort', abort));
          });

          return withWebSocketRelease(
            waitForClose.pipe(
              Effect.andThen(Effect.sleep(first ? 5 : 20)),
              Effect.andThen(Effect.fail(failure)),
            ),
            first ? Effect.fail(cleanup) : Effect.void,
          );
        });

      const url = 'ws://127.0.0.1:9/invoke';

      const session = await startWebSocketAgent(
        agent(url, {
          transport: { ...agent(url).transport, lifecycle, attempt_timeout_ms: 2000 },
        }),
      );

      try {
        const first = session.invoke(request('first', null));
        const second = session.invoke(request('second', null));
        await vi.waitFor(() => expect(failures).toHaveLength(lifecycle === 'per_case' ? 2 : 1));
        await session.close();
        const [a, b] = await Promise.all([first, second]);

        if (a.status !== 'invocation_error' || b.status !== 'invocation_error')
          throw new Error('Expected cancelled openings.');
        expect(a.error).not.toBe(b.error);
        expect(a.error.applicationStarted).toBe(true);
        expect(b.error.applicationStarted).not.toBe(true);
        expect(a.attempts.at(-1)).toMatchObject({ error: a.error });
        expect(b.attempts.at(-1)).toMatchObject({ error: b.error });
        const retained = a.error.effectCause;

        if (retained === undefined) throw new Error('Expected first opening Cause.');
        expect(retained.reasons[0]).toMatchObject({ error: failures[0] });
        const releases = Context.getOrUndefined(Cause.annotations(retained), WebSocketCleanup);
        expect(releases?.[0]?.reasons[0]).toMatchObject({ error: cleanup });
        expect(failures[0]?.effectCause).toBeUndefined();
      } finally {
        observation.mockRestore();
        await session.close();
      }
    },
  );

  it.each(['per_case', 'per_run'] as const)(
    'joins %s admission when interruption lands at a scheduler yield',
    async (lifecycle) => {
      const owner = lifecycle === 'per_case' ? PerCaseWebSocketSession : RunScopedWebSocketSession;
      const invoke = vi.spyOn(owner.prototype, 'invoke').mockReturnValue(Effect.never);

      try {
        for (let yieldAt = 1; yieldAt <= 10; yieldAt++) {
          const queued: (() => void)[] = [];
          let steps = 0;

          const scheduleTask = (task: () => void): void => {
            queued.push(task);
          };

          const scheduler = {
            executionMode: 'async' as const,
            shouldYield: () => ++steps === yieldAt,
            scheduleTask,
            makeDispatcher: () => ({ scheduleTask, flush: () => undefined }),
          };

          const scope = await run(Scope.make());
          const url = 'ws://127.0.0.1:9/invoke';
          const configured = agent(url, { transport: { ...agent(url).transport, lifecycle } });
          const session = await run(Scope.provide(acquireWebSocketAgent(configured), scope));
          const fiber = Effect.runFork(session.invoke(request('interrupt', null)), { scheduler });
          fiber.interruptUnsafe();

          while (queued.length > 0) queued.shift()?.();
          await run(Fiber.await(fiber));

          const closed = await Promise.race([
            run(session.close()).then(() => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
          ]);

          expect(closed, `close at yield ${String(yieldAt)}`).toBe(true);
          await run(Scope.close(scope, Exit.void));
        }
      } finally {
        invoke.mockRestore();
      }
    },
  );

  it.each(['per_case', 'per_run'] as const)(
    'does not replay %s when the attempt deadline wins an unanswered upgrade',
    async (lifecycle) => {
      const fixture = await startTestWebSocketServer({
        ignoreUpgrade: true,
        onMessage: () => undefined,
      });

      fixtures.push(fixture);

      const configured = agent(fixture.url, {
        retry: { retries: 1, backoff: { kind: 'none' } },
        transport: {
          ...agent(fixture.url).transport,
          lifecycle,
          open_timeout_ms: 100,
          attempt_timeout_ms: 100,
          message_idle_timeout_ms: 100,
        },
      });

      const session = await startWebSocketAgent(configured);

      try {
        const result = await session.invoke(request('deadline', null));
        expect(result).toMatchObject({
          status: 'invocation_error',
          error: { code: 'timeout', applicationStarted: true },
        });
        expect(result.attempts).toHaveLength(1);
        expect(fixture.upgradeRequests()).toBe(1);
      } finally {
        await session.close();
      }
    },
  );

  it.each([
    ['per_case', false],
    ['per_case', true],
    ['per_run', false],
    ['per_run', true],
  ] as const)(
    'retains %s opening cleanup Causes after deadline=%s',
    async (lifecycle, afterDeadline) => {
      const failure = new AgentInvocationError('network', 'Upgrade rejected.', {
        applicationStarted: true,
      });

      const cleanup = new Error('Upgrade release could not be confirmed.');

      const opening = withWebSocketRelease(
        Effect.sleep(afterDeadline ? 30 : 0).pipe(Effect.andThen(Effect.fail(failure))),
        Effect.fail(cleanup),
      );

      const observation = vi
        .spyOn(WebSocketSessionState.prototype, 'openConnection')
        .mockReturnValue(opening);

      const url = 'ws://127.0.0.1:9/invoke';

      const configured = agent(url, {
        transport: {
          ...agent(url).transport,
          lifecycle,
          open_timeout_ms: 10,
          message_idle_timeout_ms: 10,
          attempt_timeout_ms: 10,
        },
      });

      const session = await startWebSocketAgent(configured);

      try {
        const result = await session.invoke(request('rejected', null));
        expect(result.status).toBe('invocation_error');

        if (result.status !== 'invocation_error') throw new Error('Expected rejected opening.');
        expect(result.error.code).toBe(afterDeadline ? 'timeout' : 'network');
        expect(result.error.applicationStarted).toBe(true);

        const retained = result.error.effectCause;

        if (retained === undefined) throw new Error('Expected opening Cause.');
        const releases = Context.getOrUndefined(Cause.annotations(retained), WebSocketCleanup);
        expect(releases).toHaveLength(1);
        expect(releases?.[0]?.reasons[0]).toMatchObject({ _tag: 'Fail', error: cleanup });
        expect(JSON.stringify(result)).not.toContain('Upgrade release could not be confirmed.');
      } finally {
        observation.mockRestore();
        await session.close();
      }
    },
  );

  it('appends every nested cleanup failure without replacing the primary Cause', async () => {
    const failure = new AgentInvocationError('network', 'primary');
    const inner = new Error('inner release');
    const outer = new Error('outer release');

    const result = await Effect.runPromiseExit(
      withWebSocketRelease(
        withWebSocketRelease(Effect.fail(failure), Effect.fail(inner)),
        Effect.fail(outer),
      ),
    );

    if (Exit.isSuccess(result)) throw new Error('Expected primary failure.');
    expect(result.cause.reasons[0]).toMatchObject({ error: failure });
    const releases = Context.getOrUndefined(Cause.annotations(result.cause), WebSocketCleanup);
    expect(releases?.map((cause) => cause.reasons[0])).toEqual([
      expect.objectContaining({ error: inner }),
      expect.objectContaining({ error: outer }),
    ]);
  });

  it.each(['drain', 'close', 'abort', 'interrupt'] as const)(
    'detaches backpressure listeners after %s',
    async (settlement) => {
      const writes: (() => void)[] = [];

      const socket = new Duplex({
        writableHighWaterMark: 1,
        read() {},
        write(_chunk, _encoding, callback) {
          writes.push(callback);
        },
      });

      const controller = new AbortController();

      const connection = new WebSocketConnection({
        socket,
        initialData: Buffer.alloc(0),
        maximumMessageBytes: 1024,
        maximumPendingWriteBytes: 1024,
        callbacks: {
          onClose: () => undefined,
          onFailure: () => undefined,
          onPong: () => undefined,
          onText: () => undefined,
        },
      });

      const baseline = socket.listenerCount('close');

      try {
        for (let index = 0; index < (settlement === 'drain' ? 12 : 1); index++) {
          const fiber = Effect.runFork(connection.sendText('x', controller.signal));
          await new Promise<void>((resolve) => setImmediate(resolve));

          if (settlement === 'drain') writes.shift()?.();
          else if (settlement === 'close') socket.destroy();
          else if (settlement === 'abort') controller.abort();
          else fiber.interruptUnsafe();
          await run(Fiber.await(fiber));
          expect(socket.listenerCount('close')).toBe(settlement === 'close' ? 0 : baseline);
          expect(socket.listenerCount('drain')).toBe(0);
          expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
        }
      } finally {
        connection.destroy();
      }
    },
  );
});
