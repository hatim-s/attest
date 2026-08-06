import { performance } from 'node:perf_hooks';

import type { MetricDefinition } from '@attest/contracts';

import { evaluateAssertionMetric } from './assertion-engine.js';
import { AttestMetricError } from './errors.js';
import { buildEvaluationDocument } from './evaluation-document.js';
import { executeExecutableMetric } from './exec-metric.js';
import type { JudgeClient } from './judge/judge-client.js';
import type { JudgeCache } from './judge/judge-cache.js';
import { evaluateJudgeMetric } from './judge/judge-metric.js';
import type { MetricContext, MetricEvaluation } from './metric-evaluation.js';

/** Configures optional metric edges while keeping assertion evaluation dependency-free. */
type EvaluateMetricsOptions = {
  judgeClient?: JudgeClient;
  execTimeoutMs?: number;
  judgeTimeoutMs?: number;
  cache?: JudgeCache;
  signal?: AbortSignal;
};

/** Creates consistent no-output semantics before any metric kind performs work. */
const skippedMetricEvaluation = (
  definition: MetricDefinition,
  durationMs: number,
): MetricEvaluation => ({
  metricName: definition.name,
  kind: definition.type,
  status: 'error',
  error: {
    code: 'skipped_no_output',
    message: 'Metric was not evaluated because the case execution produced no completed output.',
  },
  durationMs,
});

/** Evaluates one definition after the shared execution-state guard has passed. */
const evaluateMetric = async (
  definition: MetricDefinition,
  context: MetricContext,
  options: EvaluateMetricsOptions,
): Promise<MetricEvaluation> => {
  if (definition.type === 'assertion') {
    const startedAt = performance.now();
    const outcome = evaluateAssertionMetric(definition, buildEvaluationDocument(context));
    return {
      metricName: definition.name,
      kind: 'assertion',
      status: 'evaluated',
      result: outcome.result,
      durationMs: performance.now() - startedAt,
    };
  }

  if (definition.type === 'exec') {
    return executeExecutableMetric(definition, context, {
      timeoutMs: options.execTimeoutMs,
      signal: options.signal,
    });
  }

  if (options.judgeClient === undefined) {
    const startedAt = performance.now();
    return {
      metricName: definition.name,
      kind: 'judge',
      status: 'error',
      error: {
        code: 'judge_provider_error',
        message:
          'Judge metric requires a configured judgeClient; create one with createTanstackJudgeClient().',
      },
      durationMs: performance.now() - startedAt,
    };
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
): Promise<MetricEvaluation[]> => {
  const evaluations: MetricEvaluation[] = [];

  for (const definition of definitions) {
    if (context.execution.outcome !== 'completed') {
      const startedAt = performance.now();
      evaluations.push(skippedMetricEvaluation(definition, performance.now() - startedAt));
      continue;
    }
    const startedAt = performance.now();
    try {
      evaluations.push(await evaluateMetric(definition, context, options));
    } catch (error: unknown) {
      const metricError = error instanceof AttestMetricError ? error : undefined;
      const isKnownMetricError =
        metricError !== undefined &&
        (metricError.code === 'invalid_json_schema' ||
          metricError.code === 'invalid_path' ||
          metricError.code === 'judge_provider_error' ||
          metricError.code === 'judge_unparseable_response');
      const message =
        error instanceof Error ? error.message : 'Metric evaluation threw an unknown error.';
      evaluations.push({
        metricName: definition.name,
        kind: definition.type,
        status: 'error',
        error: {
          code: isKnownMetricError ? metricError.code : 'internal_error',
          message,
          ...(isKnownMetricError && metricError.details !== undefined
            ? { details: metricError.details }
            : {}),
        },
        durationMs: performance.now() - startedAt,
      });
    }
  }

  return evaluations;
};

export { evaluateMetrics, type EvaluateMetricsOptions };
