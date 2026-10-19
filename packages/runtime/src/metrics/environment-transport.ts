import { posix } from 'node:path';

import type { CaseEnvironment } from '@attest/executor';

import { abortReasonOf, composeAbortSignal } from './internal/abort-signal.js';
import { abortedMetricError, type CommandMetricTransport } from './internal/metric-transport.js';

/** Workspace-relative locations; the command runs from the workspace root. */
const ARTIFACT_DIR = 'attest/artifacts';

const STAGING_DIR = 'attest/staging';

const REQUEST_PATH = 'attest/metric-request.json';

const MAXIMUM_STDERR_BYTES = 4 * 1024;

/** Quotes one argument for `sh`; inside single quotes only `'` itself needs escaping. */
const quote = (argument: string): string => `'${argument.replaceAll("'", `'\\''`)}'`;

/** Keeps at most `maximumBytes` of UTF-8 text without splitting the cap on a character. */
const excerpt = (text: string, maximumBytes: number): string =>
  Buffer.from(text).subarray(0, maximumBytes).toString();

/**
 * Runs command metrics inside a case environment such as a Vercel sandbox. The request goes to
 * `attest/metric-request.json`, artifacts go under `attest/artifacts/<path>`, and the command
 * reads the request on stdin. Environments write text files only, so base64 artifacts are staged
 * as text and decoded in the sandbox. Host env and cwd stay on the host; only `options.env`
 * entries are forwarded.
 */
const createEnvironmentMetricTransport = (environment: CaseEnvironment): CommandMetricTransport => {
  return async (definition, request, options) => {
    const signal = composeAbortSignal(options.signal, options.timeoutMs);

    const env = Object.fromEntries(
      Object.entries(options.env ?? {}).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );

    try {
      const directories = new Set([STAGING_DIR, ARTIFACT_DIR]);

      for (const artifact of request.artifacts) {
        directories.add(posix.dirname(posix.join(ARTIFACT_DIR, artifact.path)));
      }

      // One command both prepares the directories and reports the absolute workspace root.
      const prepared = await environment.exec(
        `mkdir -p ${[...directories].map(quote).join(' ')} && pwd`,
        { signal },
      );

      if (prepared.exitCode !== 0) {
        return {
          ok: false,
          error: {
            code: 'exec_spawn_failed',
            message: 'Could not prepare the metric sandbox workspace.',
            details: { stderr: excerpt(prepared.stderr, MAXIMUM_STDERR_BYTES) },
          },
        };
      }

      const root = prepared.stdout.trim();
      const decodes: string[] = [];

      for (const [index, artifact] of request.artifacts.entries()) {
        const destination = posix.join(ARTIFACT_DIR, artifact.path);

        if (artifact.encoding === 'utf8') {
          await environment.writeFile(destination, artifact.content);
          continue;
        }

        const staged = posix.join(STAGING_DIR, String(index));
        await environment.writeFile(staged, artifact.content);
        decodes.push(`base64 -d < ${quote(staged)} > ${quote(destination)}`);
      }

      await environment.writeFile(
        REQUEST_PATH,
        JSON.stringify({ ...request, artifact_dir: posix.join(root, ARTIFACT_DIR) }),
      );

      const command = `${definition.command.map(quote).join(' ')} < ${quote(REQUEST_PATH)}`;
      const script = ['set -e', ...decodes, command].join('\n');
      const result = await environment.exec(script, { signal, env });

      if (result.exitCode !== 0) {
        return {
          ok: false,
          error: {
            code: 'exec_nonzero_exit',
            message: `Metric command exited with code ${result.exitCode}.`,
            details:
              result.stderr.length === 0
                ? undefined
                : { stderr: excerpt(result.stderr, MAXIMUM_STDERR_BYTES) },
          },
        };
      }

      if (Buffer.byteLength(result.stdout) > options.outputCapBytes) {
        return {
          ok: false,
          error: {
            code: 'exec_malformed_output',
            message: `Metric stdout exceeded the ${options.outputCapBytes}-byte limit.`,
          },
        };
      }

      return { ok: true, text: result.stdout };
    } catch (error: unknown) {
      if (signal.aborted) {
        return { ok: false, error: abortedMetricError(abortReasonOf(signal), options.timeoutMs) };
      }

      return {
        ok: false,
        error: {
          code: 'exec_spawn_failed',
          message: `Metric sandbox command failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        },
      };
    }
  };
};

export { createEnvironmentMetricTransport };
