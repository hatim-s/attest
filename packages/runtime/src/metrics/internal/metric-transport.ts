import type { MetricErrorInfo } from '../metric-evaluation.js';
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

/** Builds the metric error for a deadline or caller cancellation, identical across transports. */
const abortedMetricError = (reason: AbortReason, timeoutMs: number): MetricErrorInfo =>
  reason === 'timeout'
    ? { code: 'exec_timeout', message: `Metric execution exceeded ${timeoutMs} ms.` }
    : { code: 'metric_cancelled', message: 'Metric execution was cancelled.' };

export { abortedMetricError, type MetricTransportOptions, type MetricTransportOutcome };
