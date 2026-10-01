import { performance } from 'node:perf_hooks';

import type { MetricDefinition } from '@attest/contracts';
import type { StoredMetricEvaluation } from '@attest/core';

import { evaluateAssertionMetric } from './assertion-engine.js';
import { AttestMetricError } from './errors.js';
import { buildEvaluationDocument } from './evaluation-document.js';
import { executeExecutableMetric, type ExecMetricOptions } from './exec-metric.js';
import type { JudgeClient } from './judge/judge-client.js';
import type { JudgeCache } from './judge/judge-cache.js';
import { evaluateJudgeMetric } from './judge/judge-metric.js';
import {
  evaluatedMetric,
  metricError,
  skippedNoOutput,
  type CompletedMetricContext,
  type MetricContext,
} from './metric-evaluation.js';

/** Configures optional metric edges while keeping assertion evaluation dependency-free. */
type EvaluateMetricsOptions = {
  exec?: Omit<ExecMetricOptions, 'signal'>;
  judgeClient?: JudgeClient;
  judgeTimeoutMs?: number;
  cache?: JudgeCache;
  signal?: AbortSignal;
};

/** Dispatches one definition by kind; only called once the case has scoreable output. */
const evaluateMetric = async (
  definition: MetricDefinition,
  context: CompletedMetricContext,
  options: EvaluateMetricsOptions,
): Promise<StoredMetricEvaluation> => {
  if (definition.type === 'assertion') {
    const result = evaluateAssertionMetric(definition, buildEvaluationDocument(context));
    return evaluatedMetric(definition, result, 0);
  }

  if (definition.type === 'exec') {
    return executeExecutableMetric(definition, context, {
      ...options.exec,
      signal: options.signal,
    });
  }

  if (options.judgeClient === undefined) {
    return metricError(
      definition,
      {
        code: 'judge_provider_error',
        message:
          'Judge metric requires a configured judgeClient; create one with createTanstackJudgeClient().',
      },
      0,
    );
  }

  return evaluateJudgeMetric(definition, context, {
    client: options.judgeClient,
    cache: options.cache,
    timeoutMs: options.judgeTimeoutMs,
    signal: options.signal,
  });
};

/**
 * Evaluates a case's metrics sequentially in definition order. Determinism wins over per-case latency
 * in v0; parallelism belongs to the runner's case-level pool where ordering stays observable.
 */
const evaluateMetrics = async (
  definitions: MetricDefinition[],
  context: MetricContext,
  options: EvaluateMetricsOptions = {},
): Promise<StoredMetricEvaluation[]> => {
  const { execution } = context;
  if (execution.outcome !== 'completed') {
    return definitions.map((definition) => skippedNoOutput(definition, execution));
  }

  const completed = { caseDefinition: context.caseDefinition, execution };
  const evaluations: StoredMetricEvaluation[] = [];
  for (const definition of definitions) {
    const startedAt = performance.now();
    try {
      evaluations.push(await evaluateMetric(definition, completed, options));
    } catch (error: unknown) {
      const known = error instanceof AttestMetricError ? error : undefined;
      const message =
        error instanceof Error ? error.message : 'Metric evaluation threw an unknown error.';
      evaluations.push(
        metricError(
          definition,
          { code: known?.code ?? 'internal_error', message, details: known?.details },
          performance.now() - startedAt,
        ),
      );
    }
  }
  return evaluations;
};

export { evaluateMetrics, type EvaluateMetricsOptions };
