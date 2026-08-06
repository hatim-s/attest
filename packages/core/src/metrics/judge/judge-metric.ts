import { performance } from 'node:perf_hooks';

import type { JsonValue, MetricDefinition, MetricResult } from '@attest/contracts';

import { buildEvaluationDocument } from '../evaluation-document.js';
import { AttestMetricError } from '../errors.js';
import {
  skippedNoOutput,
  type MetricContext,
  type MetricEvaluation,
} from '../metric-evaluation.js';
import type { JudgeClient, JudgeRecord, JudgeUsage } from './judge-client.js';
import { computeJudgeCacheKey, type JudgeCache } from './judge-cache.js';
import { summarizeTraceForJudge } from './rubric-prompt.js';

const DEFAULT_JUDGE_TIMEOUT_MS = 60_000;

/** Narrows the shared metric contract to rubric-based judge definitions. */
type JudgeMetricDefinition = Extract<MetricDefinition, { type: 'judge' }>;

/** Supplies the provider boundary and resource controls owned by the enclosing run. */
type EvaluateJudgeMetricOptions = {
  client: JudgeClient;
  cache?: JudgeCache;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/** Preserves only provider-reported usage fields in normalized metric details. */
const serializeJudgeUsage = (usage: JudgeUsage): JsonValue => ({
  ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
  ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
});

/** Converts the known JSON-shaped record while omitting optional undefined usage fields. */
const serializeJudgeRecord = (record: JudgeRecord): JsonValue => ({
  request: {
    model: record.request.model,
    system: record.request.system,
    user: record.request.user,
    params: record.request.params,
  },
  rawResponse: record.rawResponse,
  ...(record.usage === undefined ? {} : { usage: serializeJudgeUsage(record.usage) }),
  attempts: record.attempts.map((attempt) => ({
    rawResponse: attempt.rawResponse,
    ...(attempt.usage === undefined ? {} : { usage: serializeJudgeUsage(attempt.usage) }),
    ...(attempt.error === undefined ? {} : { error: attempt.error }),
  })),
});

/** Builds metric result data identically for live and cached verdicts, preserving reported token evidence. */
const createJudgeResult = (
  definition: JudgeMetricDefinition,
  verdict: { score: number; rationale: string },
  usage: JudgeUsage | undefined,
): MetricResult => {
  const threshold = definition.threshold ?? 0.5;
  return {
    score: verdict.score,
    pass: verdict.score >= threshold,
    rationale: verdict.rationale,
    ...(usage === undefined ? {} : { details: { usage: serializeJudgeUsage(usage) } }),
  };
};

/** Adds cache provenance to judge evidence so stored results distinguish a replay from a provider call. */
const withCacheProvenance = (record: JsonValue, cache: 'hit' | 'miss', key: string): JsonValue => {
  if (record !== null && !Array.isArray(record) && typeof record === 'object') {
    return { ...record, cache, key };
  }
  return { record, cache, key };
};

/**
 * Evaluates one judge rubric according to metric contract §3 while keeping provider faults distinct
 * from genuine failing scores. Full prompt/response evidence is retained for completed and attempted calls.
 */
const evaluateJudgeMetric = async (
  definition: JudgeMetricDefinition,
  context: MetricContext,
  options: EvaluateJudgeMetricOptions,
): Promise<MetricEvaluation> => {
  const startedAt = performance.now();
  if (context.execution.outcome !== 'completed') {
    return skippedNoOutput(definition.name, definition.type);
  }
  if (options.signal?.aborted) {
    return {
      metricName: definition.name,
      kind: 'judge',
      status: 'error',
      error: { code: 'metric_cancelled', message: 'Judge evaluation was cancelled.' },
      durationMs: performance.now() - startedAt,
    };
  }

  const document = buildEvaluationDocument(context);
  const request = {
    model: definition.model,
    rubric: definition.rubric,
    document: {
      input: document.input,
      output: document.output,
      expected: document.expected,
      traceSummary: summarizeTraceForJudge(document.trace),
    },
  };
  const cacheKey = options.cache === undefined ? undefined : computeJudgeCacheKey(request);
  try {
    const cached = cacheKey === undefined ? undefined : await options.cache?.get(cacheKey);
    if (cacheKey !== undefined && cached !== undefined) {
      return {
        metricName: definition.name,
        kind: 'judge',
        status: 'evaluated',
        result: createJudgeResult(definition, cached.verdict, cached.record.usage),
        judgeIo: withCacheProvenance(serializeJudgeRecord(cached.record), 'hit', cacheKey),
        durationMs: performance.now() - startedAt,
      };
    }

    const outcome = await options.client.scoreRubric(request, {
      timeoutMs: options.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS,
      signal: options.signal,
    });
    const serializedRecord = serializeJudgeRecord(outcome.record);
    if (cacheKey !== undefined) {
      try {
        await options.cache?.set(cacheKey, { verdict: outcome.verdict, record: outcome.record });
      } catch {
        // Cache persistence is advisory: a completed provider verdict remains the source of truth for this run.
      }
    }

    return {
      metricName: definition.name,
      kind: 'judge',
      status: 'evaluated',
      result: createJudgeResult(definition, outcome.verdict, outcome.record.usage),
      ...(cacheKey === undefined
        ? { judgeIo: serializedRecord }
        : { judgeIo: withCacheProvenance(serializedRecord, 'miss', cacheKey) }),
      durationMs: performance.now() - startedAt,
    };
  } catch (error: unknown) {
    const cancelled = options.signal?.aborted === true;
    const message = cancelled
      ? 'Judge evaluation was cancelled.'
      : error instanceof Error
        ? error.message
        : 'Judge provider call failed for an unknown reason.';

    return {
      metricName: definition.name,
      kind: 'judge',
      status: 'error',
      error: {
        code:
          error instanceof AttestMetricError
            ? error.code
            : cancelled
              ? 'metric_cancelled'
              : 'judge_provider_error',
        message,
        ...(error instanceof AttestMetricError && error.details !== undefined
          ? { details: error.details }
          : {}),
      },
      durationMs: performance.now() - startedAt,
    };
  }
};

export { evaluateJudgeMetric, type EvaluateJudgeMetricOptions, type JudgeMetricDefinition };
