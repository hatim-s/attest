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

/** Runs a command in the caller's execution environment and returns its bounded protocol output. */
type CommandMetricTransport = (
  definition: CommandMetricDefinition,
  requestBody: string,
  options: MetricTransportOptions,
) => Promise<MetricTransportOutcome>;

/** Builds the metric error for a deadline or caller cancellation, identical across transports. */
const abortedMetricError = (reason: AbortReason, timeoutMs: number): MetricErrorInfo =>
  reason === 'timeout'
    ? { code: 'exec_timeout', message: `Metric execution exceeded ${timeoutMs} ms.` }
    : { code: 'metric_cancelled', message: 'Metric execution was cancelled.' };

export {
  abortedMetricError,
  type MetricTransportOptions,
  type MetricTransportOutcome,
  type CommandMetricTransport,
};
