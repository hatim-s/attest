import { getEnvironmentCleanupCause } from '@attest/executor';
import { mustPropagateMetricCause } from './internal/operation.js';
import * as Effect from 'effect/Effect';
import { performance } from 'node:perf_hooks';

import type { MetricDefinition } from '@attest/contracts';
import type { StoredMetricEvaluation } from '@attest/core';

import { evaluateAssertionMetric } from './assertion-engine.js';
import { AttestMetricError, MetricOperationError } from './errors.js';
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
const evaluateMetric = (
  definition: MetricDefinition,
  context: CompletedMetricContext,
  options: EvaluateMetricsOptions,
): Effect.Effect<StoredMetricEvaluation, Error> =>
  Effect.gen(function* () {
    if (definition.type === 'assertion') {
      const result = yield* Effect.try({
        try: () => evaluateAssertionMetric(definition, buildEvaluationDocument(context)),
        catch: (cause) => {
          // Authored regex and schema configuration failures are metric diagnostics. Other throws are defects.
          if (cause instanceof AttestMetricError) return cause;

          if (cause instanceof SyntaxError)
            return new MetricOperationError({ reason: 'foreign', cause });
          throw cause;
        },
      });

      return evaluatedMetric(definition, result, 0);
    }

    if (definition.type === 'exec') {
      return yield* executeExecutableMetric(definition, context, {
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

    return yield* evaluateJudgeMetric(definition, context, {
      client: options.judgeClient,
      cache: options.cache,
      timeoutMs: options.judgeTimeoutMs,
      signal: options.signal,
    });
  });

/**
 * Evaluates a case's metrics sequentially in definition order. Determinism wins over per-case latency;
 * parallelism belongs to the runner's case-level pool where ordering stays observable.
 */
const evaluateMetrics = (
  definitions: MetricDefinition[],
  context: MetricContext,
  options: EvaluateMetricsOptions = {},
): Effect.Effect<StoredMetricEvaluation[], Error> =>
  Effect.gen(function* () {
    const { execution } = context;

    if (execution.outcome !== 'completed') {
      return definitions.map((definition) => skippedNoOutput(definition, execution));
    }

    const completed = { caseDefinition: context.caseDefinition, execution };
    const evaluations: StoredMetricEvaluation[] = [];

    for (const definition of definitions) {
      const startedAt = performance.now();

      const evaluation = yield* evaluateMetric(definition, completed, options).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (mustPropagateMetricCause(cause) || getEnvironmentCleanupCause(cause) !== undefined)
              return yield* Effect.failCause(cause);
            const error = yield* Effect.flip(Effect.failCause(cause));

            return metricError(
              definition,
              {
                code: error instanceof AttestMetricError ? error.code : 'internal_error',
                message: error.message,
                details: error instanceof AttestMetricError ? error.details : undefined,
              },
              performance.now() - startedAt,
            );
          }),
        ),
      );

      evaluations.push(evaluation);
    }

    return evaluations;
  });

export { evaluateMetrics, type EvaluateMetricsOptions };
