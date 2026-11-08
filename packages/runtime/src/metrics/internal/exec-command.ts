import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { MetricRequest } from '@attest/contracts';
import { killProcessTree, spawnInProcessGroup } from '@attest/executor';
import type { CommandMetricDefinition } from '../metric-definitions.js';
import { abortReasonOf, composeAbortSignal } from './abort-signal.js';
import {
  abortedMetricError,
  appendStderr,
  definedEnvironment,
  type MetricTransportOptions,
  type MetricTransportOutcome,
} from './metric-transport.js';
import { MetricOperationError } from '../errors.js';
import { foreign, ownOperation, withRelease, releaseAll } from './operation.js';

/** Observes process events without running cleanup from detached Promise callbacks. */
const runCommand = (
  definition: CommandMetricDefinition,
  requestBody: string,
  options: MetricTransportOptions,
): Effect.Effect<MetricTransportOutcome, Error> =>
  ownOperation((cancelled) =>
    Effect.gen(function* () {
      const signal = composeAbortSignal(
        AbortSignal.any([cancelled, ...(options.signal ? [options.signal] : [])]),
        options.timeoutMs,
      );

      if (signal.aborted)
        return { ok: false, error: abortedMetricError(abortReasonOf(signal), options.timeoutMs) };

      const observed = yield* Deferred.make<MetricTransportOutcome | 'output_cap' | 'aborted'>();

      const child = spawnInProcessGroup(definition.command, {
        cwd: options.cwd ?? process.cwd(),
        env: definedEnvironment(options.env ?? process.env),
      });

      const stop = yield* Effect.cached(
        killProcessTree(child, { graceMs: 2_000, signalProcessGroup: true }),
      );

      const chunks: Buffer[] = [];
      let bytes = 0;
      let stderr = '';
      let closed = false;

      const abort = () => {
        Deferred.doneUnsafe(observed, Effect.succeed('aborted'));
      };

      const onError = (error: Error) => {
        Deferred.doneUnsafe(
          observed,
          Effect.succeed({
            ok: false,
            error: {
              code: 'exec_spawn_failed',
              message: `Could not start metric command: ${error.message}`,
            },
          }),
        );
      };

      const onData = (chunk: Buffer) => {
        bytes += chunk.byteLength;

        if (bytes > options.outputCapBytes) {
          Deferred.doneUnsafe(observed, Effect.succeed('output_cap'));

          return;
        }

        chunks.push(chunk);
      };

      const onStderr = (chunk: Buffer) => {
        stderr = appendStderr(stderr, chunk);
      };

      const onClose = (code: number | null) => {
        closed = true;
        Deferred.doneUnsafe(
          observed,
          Effect.succeed(
            code === 0
              ? { ok: true, text: Buffer.concat(chunks).toString() }
              : {
                  ok: false,
                  error: {
                    code: 'exec_nonzero_exit',
                    message: `Metric command exited with code ${code ?? 'unknown'}.`,
                    details: stderr.length === 0 ? undefined : { stderr },
                  },
                },
          ),
        );
      };

      child.stdin?.on('error', onError);
      child.once('error', onError);
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onStderr);
      child.once('close', onClose);
      signal.addEventListener('abort', abort, { once: true });

      if (signal.aborted) abort();
      child.stdin?.end(requestBody);

      const operation = Effect.gen(function* () {
        const result = yield* Deferred.await(observed);

        if (result !== 'output_cap' && result !== 'aborted') return result;
        const cleanup = yield* stop;

        const error =
          result === 'output_cap'
            ? {
                code: 'exec_malformed_output' as const,
                message: `Metric stdout exceeded the ${options.outputCapBytes}-byte limit.`,
              }
            : abortedMetricError(abortReasonOf(signal), options.timeoutMs);

        return {
          ok: false as const,
          error: {
            ...error,
            message: cleanup.cleanupConfirmed
              ? error.message
              : `${error.message} Process may be unreaped.`,
          },
        };
      });

      return yield* withRelease(
        operation,
        releaseAll([
          Effect.gen(function* () {
            if (closed) return;
            const cleanup = yield* stop;

            if (!cleanup.cleanupConfirmed)
              return yield* new MetricOperationError({ reason: 'process_cleanup_unconfirmed' });
          }),
          Effect.sync(() => signal.removeEventListener('abort', abort)),
          Effect.sync(() => child.stdin?.removeListener('error', onError)),
          Effect.sync(() => child.removeListener('error', onError)),
          Effect.sync(() => child.removeListener('close', onClose)),
          Effect.sync(() => child.stdout?.removeListener('data', onData)),
          Effect.sync(() => child.stderr?.removeListener('data', onStderr)),
        ]),
      );
    }),
  );

/** Stages bounded contract artifacts and removes the directory after every operation Exit. */
const invokeCommandMetric = (
  definition: CommandMetricDefinition,
  request: MetricRequest,
  options: MetricTransportOptions,
) =>
  ownOperation((cancelled) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const signal = AbortSignal.any([cancelled, ...(options.signal ? [options.signal] : [])]);
        const directory = yield* foreign(() => mkdtemp(join(tmpdir(), 'attest-metric-')));

        return yield* withRelease(
          restore(
            Effect.gen(function* () {
              for (const artifact of request.artifacts) {
                if (signal.aborted)
                  return {
                    ok: false as const,
                    error: abortedMetricError(abortReasonOf(signal), options.timeoutMs),
                  };
                const destination = join(directory, artifact.path);
                yield* foreign(() => mkdir(dirname(destination), { recursive: true }));
                yield* foreign(() =>
                  writeFile(destination, Buffer.from(artifact.content, artifact.encoding)),
                );
              }

              return yield* runCommand(
                definition,
                JSON.stringify({ ...request, artifact_dir: directory }),
                { ...options, signal },
              );
            }),
          ),
          foreign(() => rm(directory, { recursive: true, force: true })),
        );
      }),
    ),
  );

export { invokeCommandMetric };
