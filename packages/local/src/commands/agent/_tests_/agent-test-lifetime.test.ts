import * as Effect from 'effect/Effect';
import * as Deferred from 'effect/Deferred';
import * as Fiber from 'effect/Fiber';
import * as Exit from 'effect/Exit';
import { describe, expect, it, vi } from 'vitest';
import * as adapter from '../adapter/invoke-resolved-agent.js';
import { runAgentTestCommand } from '../test.js';
import { createAgentProject, addAgent } from './support/agent-project.js';
import { withStoreScope, openStore } from '../../../store/index.js';
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
