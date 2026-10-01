import type { MetricDefinition } from '@attest/contracts';

/** Deterministic assertion metrics, evaluated in-process against the evaluation document. */
type AssertionMetricDefinition = Extract<MetricDefinition, { type: 'assertion' }>;

/** Executable metrics, which run either a local command or an HTTP endpoint. */
type ExecMetricDefinition = Extract<MetricDefinition, { type: 'exec' }>;

/** Executable metrics that spawn a local command. */
type CommandMetricDefinition = Extract<ExecMetricDefinition, { command: unknown }>;

/** Executable metrics that POST to an HTTP endpoint. */
type HttpMetricDefinition = Extract<ExecMetricDefinition, { url: unknown }>;

/** Rubric metrics scored by an LLM judge. */
type JudgeMetricDefinition = Extract<MetricDefinition, { type: 'judge' }>;

export {
  type AssertionMetricDefinition,
  type CommandMetricDefinition,
  type ExecMetricDefinition,
  type HttpMetricDefinition,
  type JudgeMetricDefinition,
};
