import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';

import { killProcessTree, spawnInProcessGroup } from '@attest/executor';

import type { MetricErrorInfo } from '../metric-evaluation.js';
import type { CommandMetricDefinition } from '../metric-definitions.js';
import { abortReasonOf, composeAbortSignal } from './abort-signal.js';
import {
  abortedMetricError,
  type MetricTransportOptions,
  type MetricTransportOutcome,
} from './metric-transport.js';

const MAXIMUM_STDERR_BYTES = 4 * 1024;
const PROCESS_KILL_GRACE_MS = 2_000;
const PROCESS_REAP_WAIT_MS = 5_000;

/** Selects the stable error returned after a forced process shutdown. */
type TerminationReason = 'timeout' | 'cancelled' | 'output_cap';

/** Appends only the remaining diagnostic capacity so a single stderr chunk cannot bypass its cap. */
const appendExcerpt = (value: string, chunk: Buffer, maximumBytes: number): string => {
  const remainingBytes = maximumBytes - Buffer.byteLength(value);
  if (remainingBytes <= 0) {
    return value;
  }
  return `${value}${chunk.subarray(0, remainingBytes).toString()}`;
};

/** Drops unset variables because the process-group spawner takes a plain string record. */
const toSpawnEnvironment = (env: NodeJS.ProcessEnv): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

/** Bounds the wait for Node to observe the direct child's exit so a broken platform cannot hang a run. */
const waitForExit = async (child: ChildProcess): Promise<boolean> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  try {
    await once(child, 'exit', { signal: AbortSignal.timeout(PROCESS_REAP_WAIT_MS) });
    return true;
  } catch {
    return false;
  }
};

/** Builds the metric error returned once the process tree has been swept. */
const terminationError = (
  reason: TerminationReason,
  options: MetricTransportOptions,
  reaped: boolean,
): MetricErrorInfo => {
  const errors: Record<TerminationReason, MetricErrorInfo> = {
    timeout: abortedMetricError('timeout', options.timeoutMs),
    cancelled: abortedMetricError('cancelled', options.timeoutMs),
    output_cap: {
      code: 'exec_malformed_output',
      message: `Metric stdout exceeded the ${options.outputCapBytes}-byte limit.`,
    },
  };
  const error = errors[reason];
  if (reaped) {
    return error;
  }
  return { ...error, message: `${error.message} Process may be unreaped.` };
};

/**
 * Invokes a CLI metric in its own process group. The metric owns the whole child tree: every
 * forced shutdown sweeps descendants through the executor before the outcome resolves.
 */
const invokeCommandMetric = (
  definition: CommandMetricDefinition,
  requestBody: string,
  options: MetricTransportOptions,
): Promise<MetricTransportOutcome> =>
  new Promise((resolve) => {
    const child = spawnInProcessGroup(definition.command, {
      cwd: options.cwd ?? process.cwd(),
      env: toSpawnEnvironment(options.env ?? process.env),
    });
    const signal = composeAbortSignal(options.signal, options.timeoutMs);
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let settled = false;
    let terminationReason: TerminationReason | undefined;

    const settle = (outcome: MetricTransportOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', abort);
      resolve(outcome);
    };

    const terminate = async (reason: TerminationReason): Promise<void> => {
      if (settled || terminationReason !== undefined) {
        return;
      }
      terminationReason = reason;
      try {
        // The returned descendant list is not a reliable reap signal: ps exits non-zero when none of
        // the queried PIDs exist, which the sweep reports as survivors. Direct-child exit decides.
        await killProcessTree(child, { graceMs: PROCESS_KILL_GRACE_MS, signalProcessGroup: true });
        settle({ ok: false, error: terminationError(reason, options, await waitForExit(child)) });
      } catch (error: unknown) {
        const cleanupError = terminationError(reason, options, false);
        const detail = error instanceof Error ? error.message : 'unknown error';
        settle({
          ok: false,
          error: { ...cleanupError, message: `${cleanupError.message} Cleanup failed: ${detail}` },
        });
      }
    };

    // terminate settles every failure itself, so its promise is deliberately detached.
    const abort = (): void => void terminate(abortReasonOf(signal));

    child.once('error', (error) => {
      settle({
        ok: false,
        error: {
          code: 'exec_spawn_failed',
          message: `Could not start metric command: ${error.message}`,
        },
      });
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (terminationReason !== undefined) {
        return;
      }
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > options.outputCapBytes) {
        void terminate('output_cap');
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendExcerpt(stderr, chunk, MAXIMUM_STDERR_BYTES);
    });
    child.once('close', (exitCode) => {
      if (terminationReason !== undefined) {
        return;
      }
      if (exitCode !== 0) {
        settle({
          ok: false,
          error: {
            code: 'exec_nonzero_exit',
            message: `Metric command exited with code ${exitCode ?? 'unknown'}.`,
            details: stderr.length === 0 ? undefined : { stderr },
          },
        });
        return;
      }
      settle({ ok: true, text: Buffer.concat(stdoutChunks).toString() });
    });

    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    child.stdin?.end(requestBody);
  });

export { invokeCommandMetric };
