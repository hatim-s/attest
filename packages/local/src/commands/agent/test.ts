import * as Effect from 'effect/Effect';
import * as Cause from 'effect/Cause';
import * as Exit from 'effect/Exit';
import { finishWithRelease } from './adapter/lifecycle-cause.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { JsonValue } from '@attest/contracts';

import { LocalError } from '../../errors/index.js';
import { parseJsonText, readSourceText } from '../../internal/source-text.js';
import { openStore, withStoreScope } from '../../store/index.js';
import { loadCommandProject } from '../project/load-command-project.js';
import type { AgentTestResult, CommandResult } from '../shared/command-result.js';
import type { ReadInput } from './authoring/types.js';
import { testNativeAgentConnection } from './adapter/test-native-agent.js';
import { findResource } from '../shared/resource-lookup.js';
import type { AgentTestCommandOptions } from './types.js';

type AgentTestInputOptions = {
  input?: string;
  inputFile?: string;
  readStdin: ReadInput;
  workingDirectory: string;
};

/** Reads the probe input from `--input` or `--input-file`; with neither, the input is `{}`. */
const readAgentTestInput = Effect.fn('readAgentTestInput')(function* (
  options: AgentTestInputOptions,
): Effect.fn.Return<JsonValue, LocalError> {
  try {
    if (options.input !== undefined && options.inputFile !== undefined) {
      return yield* Effect.fail(
        new LocalError('cli_usage', 'Agent test input sources overlap.', {
          path: '--input',
          hint: 'Pass either `--input` or `--input-file`, not both.',
        }),
      );
    }

    const hint = 'Pass any valid JSON scalar, array, or object.';

    if (options.inputFile !== undefined) {
      const text = yield* readSourceText(options.inputFile, {
        path: '--input-file',
        readStdin: options.readStdin,
        workingDirectory: options.workingDirectory,
      });

      return parseJsonText(text, { path: '--input-file', hint });
    }

    return options.input === undefined
      ? {}
      : parseJsonText(options.input, { path: '--input', hint });
  } catch (error) {
    if (error instanceof LocalError) return yield* Effect.fail(error);
    throw error;
  }
});

/** Probes one adapter, finalizing recorded evidence before the store owner closes. */
const runAgentTestCommand = Effect.fn('runAgentTestCommand')(
  function* (
    options: AgentTestCommandOptions,
  ): Effect.fn.Return<CommandResult<'agent-test', AgentTestResult>, Error> {
    try {
      const { request } = options;

      const loaded = yield* loadCommandProject({
        project: options.project,
        workingDirectory: options.workingDirectory,
      });

      const agent = findResource('agent', loaded.agents, request.agent_id);

      const probe = (recording?: {
        runId: string;
        record: NonNullable<Parameters<typeof testNativeAgentConnection>[0]['onExecution']>;
      }) =>
        testNativeAgentConnection({
          agent,
          input: request.input,
          onExecution: recording?.record,
          onProgress: options.watch === true ? options.onProgress : undefined,
          projectRoot: loaded.root,
          runId: recording?.runId,
          signal: options.signal,
        });

      const result =
        request.record !== true
          ? yield* probe()
          : yield* withStoreScope((owner) =>
              Effect.gen(function* () {
                yield* Effect.tryPromise({
                  try: () => mkdir(join(loaded.root, '.attest'), { recursive: true }),
                  catch: (cause) =>
                    // Same code and message the Promise version surfaced for a raw filesystem error.
                    new LocalError(
                      'internal_error',
                      cause instanceof Error ? cause.message : String(cause),
                      { cause },
                    ),
                });
                const store = yield* openStore(join(loaded.root, '.attest', 'runs.db'), owner);

                return yield* Effect.uninterruptibleMask((restore) =>
                  Effect.gen(function* () {
                    const run = yield* store.runs.createRun({
                      schemaId: 'attest.agent-test',
                      configHash: loaded.projectHash,
                      configJson: JSON.stringify({
                        agent_id: agent.id,
                        project_hash: loaded.projectHash,
                      }),
                      labels: { agent_id: agent.id, kind: 'agent-probe' },
                    });

                    const primary = yield* Effect.exit(
                      restore(
                        probe({
                          runId: run.id,
                          record: (execution) => store.runs.recordCase(run.id, execution, []),
                        }),
                      ),
                    );

                    const cancelled =
                      Exit.isFailure(primary) &&
                      (Cause.hasInterrupts(primary.cause) ||
                        primary.cause.reasons.some(
                          (reason) =>
                            Cause.isFailReason(reason) &&
                            reason.error instanceof LocalError &&
                            reason.error.code === 'cancelled',
                        ));

                    const release = yield* Effect.exit(
                      store.runs.finalizeRun(
                        run.id,
                        Exit.isSuccess(primary) ? 'completed' : cancelled ? 'cancelled' : 'failed',
                      ),
                    );

                    const value = yield* finishWithRelease(primary, [release]);

                    return { ...value, recorded_run_id: run.id };
                  }),
                );
              }),
            );

      return {
        operation: 'agent-test',
        projectHashAfter: loaded.projectHash,
        projectHashBefore: loaded.projectHash,
        result,
      };
    } catch (error) {
      if (error instanceof LocalError) return yield* Effect.fail(error);
      throw error;
    }
  },
  Effect.mapError((error) =>
    error instanceof LocalError
      ? error
      : new LocalError('internal_error', error.message, { cause: error }),
  ),
);

export { readAgentTestInput, runAgentTestCommand };
