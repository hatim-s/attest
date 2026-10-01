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

type JudgeCallResolution = {
  outcome: Awaited<ReturnType<JudgeClient['scoreRubric']>>;
  source: 'hit' | 'miss';
};

type InFlightJudgeCall = {
  client: JudgeClient;
  cache: JudgeCache;
  signal: AbortSignal | undefined;
  timeoutMs: number;
  cacheKey: string;
  promise: Promise<JudgeCallResolution>;
};

// Buckets avoid scanning unrelated requests. Identity checks inside each bucket keep callers isolated.
const inFlightJudgeCalls = new Map<string, Set<InFlightJudgeCall>>();

/** Copies provider-owned JSON before hooks can mutate the case-local evidence. */
const cloneJsonValue = (value: JsonValue): JsonValue => {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(cloneJsonValue);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, cloneJsonValue(child)]),
  );
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
    params: Object.fromEntries(
      Object.entries(record.request.params).map(([key, value]) => [key, cloneJsonValue(value)]),
    ),
  },
  rawResponse: cloneJsonValue(record.rawResponse),
  ...(record.usage === undefined ? {} : { usage: serializeJudgeUsage(record.usage) }),
  attempts: record.attempts.map((attempt) => ({
    rawResponse: cloneJsonValue(attempt.rawResponse),
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
const withCacheProvenance = (
  record: JsonValue,
  cache: 'hit' | 'miss' | 'coalesced',
  key: string,
): JsonValue => {
  if (record !== null && !Array.isArray(record) && typeof record === 'object') {
    return { ...record, cache, key };
  }
  return { record, cache, key };
};

/** Stops work that lost its caller before it reaches the provider or durable cache. */
const throwIfJudgeCancelled = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) {
    throw new Error('Judge evaluation was cancelled.');
  }
};

/** Resolves the durable cache and provider call as one shareable operation. */
const resolveCachedJudgeCall = async (
  client: JudgeClient,
  cache: JudgeCache,
  request: Parameters<JudgeClient['scoreRubric']>[0],
  cacheKey: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<JudgeCallResolution> => {
  throwIfJudgeCancelled(signal);
  const cached = await cache.get(cacheKey);
  throwIfJudgeCancelled(signal);
  if (cached !== undefined) {
    return { outcome: cached, source: 'hit' };
  }

  const outcome = await client.scoreRubric(request, { timeoutMs, signal });
  throwIfJudgeCancelled(signal);
  try {
    await cache.set(cacheKey, { verdict: outcome.verdict, record: outcome.record });
  } catch {
    // Cache persistence is advisory: a completed provider verdict remains the source of truth for this run.
  }
  return { outcome, source: 'miss' };
};

/** Shares only calls with the same provider, cache, cancellation, timeout, and rendered request. */
const getOrStartCachedJudgeCall = (
  client: JudgeClient,
  cache: JudgeCache,
  request: Parameters<JudgeClient['scoreRubric']>[0],
  cacheKey: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): { promise: Promise<JudgeCallResolution>; coalesced: boolean } => {
  const bucket = inFlightJudgeCalls.get(cacheKey);
  for (const call of bucket ?? []) {
    if (
      call.client === client &&
      call.cache === cache &&
      call.signal === signal &&
      call.timeoutMs === timeoutMs &&
      call.cacheKey === cacheKey
    ) {
      return { promise: call.promise, coalesced: true };
    }
  }

  const promise = resolveCachedJudgeCall(client, cache, request, cacheKey, timeoutMs, signal);
  const call: InFlightJudgeCall = { client, cache, signal, timeoutMs, cacheKey, promise };
  const activeBucket = bucket ?? new Set<InFlightJudgeCall>();
  activeBucket.add(call);
  inFlightJudgeCalls.set(cacheKey, activeBucket);
  const removeCall = (): void => {
    activeBucket.delete(call);
    if (activeBucket.size === 0 && inFlightJudgeCalls.get(cacheKey) === activeBucket) {
      inFlightJudgeCalls.delete(cacheKey);
    }
  };
  void promise.then(
    () => removeCall(),
    () => removeCall(),
  );
  return { promise, coalesced: false };
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
  const timeoutMs = options.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS;
  try {
    if (cacheKey === undefined || options.cache === undefined) {
      const outcome = await options.client.scoreRubric(request, {
        timeoutMs,
        signal: options.signal,
      });
      return {
        metricName: definition.name,
        kind: 'judge',
        status: 'evaluated',
        result: createJudgeResult(definition, outcome.verdict, outcome.record.usage),
        judgeIo: serializeJudgeRecord(outcome.record),
        durationMs: performance.now() - startedAt,
      };
    }

    const pending = getOrStartCachedJudgeCall(
      options.client,
      options.cache,
      request,
      cacheKey,
      timeoutMs,
      options.signal,
    );
    const resolution = await pending.promise;
    const outcome = resolution.outcome;
    const provenance =
      resolution.source === 'hit' ? 'hit' : pending.coalesced ? 'coalesced' : 'miss';

    return {
      metricName: definition.name,
      kind: 'judge',
      status: 'evaluated',
      result: createJudgeResult(definition, outcome.verdict, outcome.record.usage),
      judgeIo: withCacheProvenance(serializeJudgeRecord(outcome.record), provenance, cacheKey),
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
