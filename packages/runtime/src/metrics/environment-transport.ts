import * as Effect from 'effect/Effect';
import { ownOperation, mustPropagateMetricCause } from './internal/operation.js';
import { posix } from 'node:path';

import { getEnvironmentCleanupCause, type CaseEnvironment } from '@attest/executor';

import { abortReasonOf, composeAbortSignal } from './internal/abort-signal.js';
import {
  abortedMetricError,
  appendStderr,
  definedEnvironment,
  type CommandMetricTransport,
  type MetricTransportOutcome,
} from './internal/metric-transport.js';

/** Workspace-relative locations; the command runs from the workspace root. */
const ARTIFACT_DIR = 'attest/artifacts';

const STAGING_DIR = 'attest/staging';

const REQUEST_PATH = 'attest/metric-request.json';

/** Quotes one argument for `sh`; inside single quotes only `'` itself needs escaping. */
const quote = (argument: string): string => `'${argument.replaceAll("'", `'\\''`)}'`;

/**
 * Runs command metrics inside a case environment such as a Vercel sandbox. The request goes to
 * `attest/metric-request.json`, artifacts go under `attest/artifacts/<path>`, and the command
 * reads the request on stdin. Environments write text files only, so base64 artifacts are staged
 * as text and decoded in the sandbox. Host env and cwd stay on the host; only `options.env`
 * entries are forwarded.
 */
const createEnvironmentMetricTransport = (environment: CaseEnvironment): CommandMetricTransport => {
  return (definition, request, options) =>
    ownOperation((cancelled) =>
      Effect.gen(function* () {
        const signal = composeAbortSignal(
          AbortSignal.any([cancelled, ...(options.signal ? [options.signal] : [])]),
          options.timeoutMs,
        );

        const env = definedEnvironment(options.env ?? {});

        return yield* Effect.gen(function* () {
          const directories = new Set([STAGING_DIR, ARTIFACT_DIR]);

          for (const artifact of request.artifacts) {
            directories.add(posix.dirname(posix.join(ARTIFACT_DIR, artifact.path)));
          }

          // One command both prepares the directories and reports the absolute workspace root.
          const prepared = yield* environment.exec(
            `mkdir -p ${[...directories].map(quote).join(' ')} && pwd`,
            { signal },
          );

          if (prepared.exitCode !== 0) {
            return {
              ok: false as const,
              error: {
                code: 'exec_spawn_failed' as const,
                message: 'Could not prepare the metric sandbox workspace.',
                details: { stderr: appendStderr('', Buffer.from(prepared.stderr)) },
              },
            };
          }

          const root = prepared.stdout.trim();
          const decodes: string[] = [];

          for (const [index, artifact] of request.artifacts.entries()) {
            const destination = posix.join(ARTIFACT_DIR, artifact.path);

            if (artifact.encoding === 'utf8') {
              yield* environment.writeFile(destination, artifact.content);
              continue;
            }

            const staged = posix.join(STAGING_DIR, String(index));
            yield* environment.writeFile(staged, artifact.content);
            decodes.push(`base64 -d < ${quote(staged)} > ${quote(destination)}`);
          }

          yield* environment.writeFile(
            REQUEST_PATH,
            JSON.stringify({ ...request, artifact_dir: posix.join(root, ARTIFACT_DIR) }),
          );

          const command = `${definition.command.map(quote).join(' ')} < ${quote(REQUEST_PATH)}`;
          const script = ['set -e', ...decodes, command].join('\n');
          const result = yield* environment.exec(script, { signal, env });

          if (result.exitCode !== 0) {
            return {
              ok: false as const,
              error: {
                code: 'exec_nonzero_exit' as const,
                message: `Metric command exited with code ${result.exitCode}.`,
                details:
                  result.stderr.length === 0
                    ? undefined
                    : { stderr: appendStderr('', Buffer.from(result.stderr)) },
              },
            };
          }

          if (Buffer.byteLength(result.stdout) > options.outputCapBytes) {
            return {
              ok: false as const,
              error: {
                code: 'exec_malformed_output' as const,
                message: `Metric stdout exceeded the ${options.outputCapBytes}-byte limit.`,
              },
            };
          }

          return { ok: true as const, text: result.stdout };
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (
                mustPropagateMetricCause(cause) ||
                getEnvironmentCleanupCause(cause) !== undefined
              )
                return yield* Effect.failCause(cause);
              const error = yield* Effect.flip(Effect.failCause(cause));

              return {
                ok: false,
                error: signal.aborted
                  ? abortedMetricError(abortReasonOf(signal), options.timeoutMs)
                  : {
                      code: 'exec_spawn_failed',
                      message: `Metric sandbox command failed: ${error.message}`,
                    },
              } satisfies MetricTransportOutcome;
            }),
          ),
        );
      }),
    );
};

export { createEnvironmentMetricTransport };
