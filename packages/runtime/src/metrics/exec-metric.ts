import { performance } from 'node:perf_hooks';

import { parseMetricResult, type ContractIssue, type MetricResult } from '@attest/contracts';

import type { StoredMetricEvaluation } from '@attest/core';

import {
  evaluatedMetric,
  metricError,
  type CompletedMetricContext,
  type MetricErrorInfo,
} from './metric-evaluation.js';
import type { ExecMetricDefinition } from './metric-definitions.js';
import type { CommandMetricTransport } from './internal/metric-transport.js';
import { invokeHttpMetric } from './internal/exec-http.js';
import { buildMetricRequest } from './internal/metric-request.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_CAP_BYTES = 1024 * 1024;

/** Applies one deadline, cancellation signal, and byte cap consistently across CLI and HTTP metrics. */
type ExecMetricOptions = {
  /** Executes command metrics in a host-owned environment while retaining shared scoring. */
  commandTransport?: CommandMetricTransport;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  outputCapBytes?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
};

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
  context: CompletedMetricContext,
  options: ExecMetricOptions = {},
): Promise<StoredMetricEvaluation> => {
  const startedAt = performance.now();
  const transportOptions = {
    ...options,
    outputCapBytes: options.outputCapBytes ?? DEFAULT_OUTPUT_CAP_BYTES,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  const requestBody = JSON.stringify(buildMetricRequest(context));
  const outcome =
    'command' in definition
      ? await (
          options.commandTransport ??
          (await import('./internal/exec-command.js')).invokeCommandMetric
        )(definition, requestBody, transportOptions)
      : await invokeHttpMetric(definition, requestBody, transportOptions);
  const parsed = outcome.ok ? parseInvocationResult(outcome.text) : outcome;
  const durationMs = performance.now() - startedAt;

  if (!parsed.ok) {
    return metricError(definition, parsed.error, durationMs);
  }
  return evaluatedMetric(definition, parsed.result, durationMs);
};

export { executeExecutableMetric, type ExecMetricOptions };
