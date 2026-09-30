import { performance } from 'node:perf_hooks';

import { parseMetricResult, type ContractIssue, type MetricResult } from '@attest/contracts';

import {
  skippedNoOutput,
  type MetricContext,
  type MetricErrorInfo,
  type MetricEvaluation,
} from './metric-evaluation.js';
import type { ExecMetricDefinition } from './metric-definitions.js';
import { invokeCommandMetric } from './internal/exec-command.js';
import { invokeHttpMetric } from './internal/exec-http.js';
import { buildMetricRequest } from './internal/metric-request.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_CAP_BYTES = 1024 * 1024;

/** Applies one deadline, cancellation signal, and byte cap consistently across CLI and HTTP metrics. */
type ExecMetricOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  outputCapBytes?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
};

/** Produces the result union used by every exit path, preserving metric errors apart from failing scores. */
const metricError = (
  definition: ExecMetricDefinition,
  error: MetricErrorInfo,
  durationMs: number,
): MetricEvaluation => ({
  metricName: definition.name,
  kind: 'exec',
  status: 'error',
  error,
  durationMs,
});

/** Makes parser diagnostics renderable and diffable without relying on Zod's internal issue objects. */
const describeContractIssues = (issues: ContractIssue[]): MetricErrorInfo['details'] => ({
  issues: issues.map((issue) => ({ path: issue.path, message: issue.message })),
});

/** Parses one transport body into the contract result, turning protocol violations into metric errors. */
const parseInvocationResult = (
  text: string,
): { ok: true; result: MetricResult } | { ok: false; error: MetricErrorInfo } => {
  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: 'exec_malformed_output',
        message: `Metric output was not valid JSON: ${error instanceof Error ? error.message : 'unknown error'}`,
      },
    };
  }

  const parsed = parseMetricResult(candidate);
  if (!parsed.ok) {
    return {
      ok: false,
      error: {
        code: 'exec_malformed_output',
        message: 'Metric output did not match the result contract.',
        details: describeContractIssues(parsed.error),
      },
    };
  }
  return { ok: true, result: parsed.value };
};

/**
 * Runs one executable metric and normalizes either transport through the shared metric result contract.
 * Invocation faults remain diagnostics so a transport failure never masquerades as a genuine score.
 */
const executeExecutableMetric = async (
  definition: ExecMetricDefinition,
  context: MetricContext,
  options: ExecMetricOptions = {},
): Promise<MetricEvaluation> => {
  const startedAt = performance.now();
  if (context.execution.outcome !== 'completed') {
    return skippedNoOutput(definition.name, definition.type);
  }

  const transportOptions = {
    ...options,
    outputCapBytes: options.outputCapBytes ?? DEFAULT_OUTPUT_CAP_BYTES,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  const requestBody = JSON.stringify(buildMetricRequest(context));
  const outcome =
    'command' in definition
      ? await invokeCommandMetric(definition, requestBody, transportOptions)
      : await invokeHttpMetric(definition, requestBody, transportOptions);
  const parsed = outcome.ok ? parseInvocationResult(outcome.text) : outcome;
  const durationMs = performance.now() - startedAt;

  if (!parsed.ok) {
    return metricError(definition, parsed.error, durationMs);
  }
  return {
    metricName: definition.name,
    kind: 'exec',
    status: 'evaluated',
    result: parsed.result,
    durationMs,
  };
};

export { executeExecutableMetric, type ExecMetricOptions };
