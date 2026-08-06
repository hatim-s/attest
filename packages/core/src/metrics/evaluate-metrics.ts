import { performance } from 'node:perf_hooks';

import type { MetricDefinition } from '@attest/contracts';

import { evaluateAssertionMetric } from './assertion-engine.js';
import { AttestMetricError } from './errors.js';
import { buildEvaluationDocument } from './evaluation-document.js';
import { executeExecutableMetric } from './exec-metric.js';
import type { JudgeClient } from './judge/judge-client.js';
import type { JudgeCache } from './judge/judge-cache.js';
import { evaluateJudgeMetric } from './judge/judge-metric.js';
import { skippedNoOutput, type MetricContext, type MetricEvaluation } from './metric-evaluation.js';

/** Configures optional metric edges while keeping assertion evaluation dependency-free. */
type EvaluateMetricsOptions = {
  judgeClient?: JudgeClient;
  execTimeoutMs?: number;
  judgeTimeoutMs?: number;
  cache?: JudgeCache;
  signal?: AbortSignal;
};

/** Evaluates one definition after the shared execution-state guard has passed. */
const evaluateMetric = async (
  definition: MetricDefinition,
  context: MetricContext,
  options: EvaluateMetricsOptions,
): Promise<MetricEvaluation> => {
  if (definition.type === 'assertion') {
    const result = evaluateAssertionMetric(definition, buildEvaluationDocument(context));
    return {
      metricName: definition.name,
      kind: 'assertion',
      status: 'evaluated',
      result,
      // Assertion checks are in-process computation, not measurable external metric work.
      durationMs: 0,
    };
  }

  if (definition.type === 'exec') {
    return executeExecutableMetric(definition, context, {
      timeoutMs: options.execTimeoutMs,
      signal: options.signal,
    });
  }

  if (options.judgeClient === undefined) {
    return {
      metricName: definition.name,
      kind: 'judge',
      status: 'error',
      error: {
        code: 'judge_provider_error',
        message:
          'Judge metric requires a configured judgeClient; create one with createTanstackJudgeClient().',
      },
      // This only constructs the configuration error; no judge request was made.
      durationMs: 0,
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
      evaluations.push(skippedNoOutput(definition.name, definition.type, context.execution));
      continue;
    }
    const startedAt = performance.now();
    try {
      evaluations.push(await evaluateMetric(definition, context, options));
    } catch (error: unknown) {
      const metricError = error instanceof AttestMetricError ? error : undefined;
      const message =
        error instanceof Error ? error.message : 'Metric evaluation threw an unknown error.';
      evaluations.push({
        metricName: definition.name,
        kind: definition.type,
        status: 'error',
        error: {
          code: metricError?.code ?? 'internal_error',
          message,
          ...(metricError?.details !== undefined ? { details: metricError.details } : {}),
        },
        durationMs: performance.now() - startedAt,
      });
    }
  }

  return evaluations;
};

export { evaluateMetrics, type EvaluateMetricsOptions };
