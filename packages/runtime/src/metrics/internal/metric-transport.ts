import type { MetricRequest } from '@attest/contracts';

import type { MetricErrorInfo } from '../metric-evaluation.js';
import type { CommandMetricDefinition } from '../metric-definitions.js';
import type { AbortReason } from './abort-signal.js';

/** Limits and cancellation shared by the command and HTTP transports once defaults are applied. */
type MetricTransportOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  outputCapBytes: number;
  signal?: AbortSignal;
  timeoutMs: number;
};

/** Keeps transport errors separate from successful response text. */
type MetricTransportOutcome = { ok: true; text: string } | { ok: false; error: MetricErrorInfo };

/**
 * Runs a command in the caller's execution environment and returns its bounded protocol output.
 * It takes the request object so it can write the artifacts as files and set `artifact_dir`.
 */
type CommandMetricTransport = (
  definition: CommandMetricDefinition,
  request: MetricRequest,
  options: MetricTransportOptions,
) => Promise<MetricTransportOutcome>;

const MAXIMUM_STDERR_BYTES = 4 * 1024;

/** Appends only the remaining stderr capacity so a single chunk cannot bypass the cap. */
const appendStderr = (value: string, chunk: Buffer): string => {
  const remainingBytes = MAXIMUM_STDERR_BYTES - Buffer.byteLength(value);

  if (remainingBytes <= 0) {
    return value;
  }

  return `${value}${chunk.subarray(0, remainingBytes).toString()}`;
};

/** Drops unset variables because spawners and case environments take a plain string record. */
const definedEnvironment = (env: NodeJS.ProcessEnv): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

/** Builds the metric error for a deadline or caller cancellation, identical across transports. */
const abortedMetricError = (reason: AbortReason, timeoutMs: number): MetricErrorInfo =>
  reason === 'timeout'
    ? { code: 'exec_timeout', message: `Metric execution exceeded ${timeoutMs} ms.` }
    : { code: 'metric_cancelled', message: 'Metric execution was cancelled.' };

export {
  abortedMetricError,
  appendStderr,
  definedEnvironment,
  type MetricTransportOptions,
  type MetricTransportOutcome,
  type CommandMetricTransport,
};
