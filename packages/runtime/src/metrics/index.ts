export { caseExecutionToMetricContext } from './case-execution-adapter.js';
export { evaluateMetrics, type EvaluateMetricsOptions } from './evaluate-metrics.js';
export type { MetricContext } from './metric-evaluation.js';
export type { JudgeCache } from './judge/judge-cache.js';
export type { JudgeClient, JudgeOutcome } from './judge/judge-client.js';
export {
  createTanstackJudgeClient,
  type TanstackJudgeClientOptions,
} from './judge/tanstack-judge-client.js';

export type { ExecMetricOptions } from './exec-metric.js';
export type {
  CommandMetricTransport,
  MetricTransportOptions,
  MetricTransportOutcome,
} from './internal/metric-transport.js';
