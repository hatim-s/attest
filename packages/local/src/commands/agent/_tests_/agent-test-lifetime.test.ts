import * as Effect from 'effect/Effect';
import * as Deferred from 'effect/Deferred';
import * as Fiber from 'effect/Fiber';
import * as Exit from 'effect/Exit';
import { describe, expect, it, vi } from 'vitest';
import { AgentInvocationError } from '@attest/executor';
import type { StoredCaseExecution } from '@attest/core';
import { testNativeAgentConnection } from '../adapter/test-native-agent.js';
import { valueFromExit } from '../../../internal/effect-exit.js';
import * as adapter from '../adapter/invoke-resolved-agent.js';
import { runAgentTestCommand } from '../test.js';
import { createAgentProject, addAgent } from './support/agent-project.js';
import { withStoreScope, openStore } from '../../../store/index.js';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { COMMAND_REQUEST_SCHEMA_ID, type AgentResource } from '@attest/contracts';

const agent: AgentResource = {
  schema: 'attest.agent',
  id: 'probe',
  name: 'probe',
  transport: {
    kind: 'background_cli',
    lifecycle: 'per_run',
    start_argv: ['echo'],
    readiness: { kind: 'stderr', pattern: 'READY' },
    invoke: { method: 'POST', url: 'http://127.0.0.1:41989/invoke' },
    extraction: { result_pointer: '/output' },
    stop_timeout_ms: 50,
  },
};

describe('native probe lifetime', () => {
  it('records startup evidence when invocation and session close both fail', async () => {
    const root = await realpath(await createAgentProject());
    const primary = new AgentInvocationError('network', 'Invocation failed.');
    const recorded: StoredCaseExecution[] = [];

    const startup = vi.spyOn(adapter, 'startAgentRuntime').mockImplementation((resolved) => {
      if (resolved.kind !== 'background') throw new Error('Expected background agent');

      return Effect.succeed({
        kind: 'session' as const,
        resolved,
        session: {
          invoke: () => Effect.fail(primary),
          close: () => Effect.fail(new AgentInvocationError('network', 'Close failed.')),
        },
      });
    });

    const invocation = vi
      .spyOn(adapter, 'invokeResolvedAgent')
      .mockImplementation(() => Effect.fail(primary));

    try {
      await expect(
        Effect.runPromise(
          Effect.exit(
            testNativeAgentConnection({
              agent,
              input: {},
              projectRoot: root,
              onExecution: (execution) =>
                Effect.sync(() => {
                  recorded.push(execution);
                }),
            }),
          ),
        ).then(valueFromExit),
      ).rejects.toMatchObject({
        code: 'invocation_failed',
        message: 'Agent connection test failed: Invocation failed.',
      });
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        outcome: 'invocation_error',
        errorCode: 'network',
        errorMessage: 'Invocation failed.',
      });
    } finally {
      startup.mockRestore();
      invocation.mockRestore();
    }
  });

  it.each(['session', 'sandbox'] as const)(
    'joins %s release before interruption completes',
    async (kind) => {
      const root = await createAgentProject();
      await addAgent(root, agent);
      const entered = Deferred.makeUnsafe<void>();
      const releases: string[] = [];
      const startup = vi.spyOn(adapter, 'startAgentRuntime');
      const invocation = vi.spyOn(adapter, 'invokeResolvedAgent');
      startup.mockImplementation((resolved) =>
        Effect.gen(function* () {
          if (resolved.kind !== 'background') throw new Error('Expected background agent');
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              if (kind === 'session') releases.push('scope');
            }),
          );

          return {
            kind: 'session',
            resolved,
            session: {
              close: () =>
                Effect.sync(() => {
                  if (kind === 'session') releases.push('close');
                }),
              invoke: () => Effect.never,
            },
          };
        }),
      );
      invocation.mockImplementation(() =>
        Effect.scoped(
          Effect.gen(function* () {
            if (kind === 'sandbox')
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  releases.push('sandbox');
                }),
              );
            yield* Deferred.succeed(entered, undefined);

            return yield* Effect.never;
          }),
        ),
      );

      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(
              runAgentTestCommand({
                project: root,
                workingDirectory: root,
                request: {
                  schema: COMMAND_REQUEST_SCHEMA_ID,
                  command: 'agent.test',
                  agent_id: agent.id,
                  input: {},
                  record: true,
                },
              }),
            );

            yield* Deferred.await(entered);
            yield* Fiber.interrupt(fiber);
            expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true);
            expect(releases).toEqual(kind === 'session' ? ['close', 'scope'] : ['sandbox']);

            const runs = yield* withStoreScope((owner) =>
              Effect.gen(function* () {
                const store = yield* openStore(join(root, '.attest', 'runs.db'), owner);

                return yield* store.runs.listRuns();
              }),
            );

            expect(runs.items).toHaveLength(1);
            expect(runs.items[0]?.status).toBe('cancelled');
          }),
        );
      } finally {
        startup.mockRestore();
        invocation.mockRestore();
      }
    },
  );
});
