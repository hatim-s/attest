import { z } from 'zod';
import { performance } from 'node:perf_hooks';

import type { JsonValue } from '@attest/contracts';
import { canonicalStringify, type StoredMetricEvaluation } from '@attest/core';

import { buildEvaluationDocument } from '../evaluation-document.js';
import { AttestMetricError } from '../errors.js';
import type { JudgeMetricDefinition } from '../metric-definitions.js';
import {
  evaluatedMetric,
  metricError,
  type CompletedMetricContext,
  type MetricErrorInfo,
} from '../metric-evaluation.js';
import type { JudgeClient, JudgeRequest } from './judge-client.js';
import type { JudgeOutcome } from './judge-outcome-schema.js';
import { resolveThroughJudgeCache, type JudgeCache } from './judge-cache.js';
import { summarizeTraceForJudge } from './rubric-prompt.js';

const DEFAULT_JUDGE_TIMEOUT_MS = 60_000;

const DEFAULT_JUDGE_THRESHOLD = 0.5;

/** Supplies the provider boundary and resource controls owned by the enclosing run. */
type EvaluateJudgeMetricOptions = {
  client: JudgeClient;
  cache?: JudgeCache;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/**
 * Copies judge evidence into plain JSON. Records carry optional fields that may be undefined, which
 * the store's JSON schema rejects, and hooks must not mutate provider-owned objects.
 */
// BOUNDARY: Judge evidence is canonicalized and checked as JSON before persistence.
const toJson = (value: unknown): JsonValue => z.json().parse(JSON.parse(canonicalStringify(value)));

/** Scores one outcome identically for live and cached verdicts, keeping token usage as evidence. */
const judgeEvaluation = (
  definition: JudgeMetricDefinition,
  outcome: JudgeOutcome,
  judgeIo: JsonValue,
  durationMs: number,
): StoredMetricEvaluation => {
  const { verdict, record } = outcome;
  const threshold = definition.threshold ?? DEFAULT_JUDGE_THRESHOLD;

  const result = {
    score: verdict.score,
    pass: verdict.score >= threshold,
    rationale: verdict.rationale,
    details: record.usage === undefined ? undefined : toJson({ usage: record.usage }),
  };

  return { ...evaluatedMetric(definition, result, durationMs), judgeIo };
};

/** Classifies a failed judge call; typed metric errors keep their code and evidence. */
const judgeFailure = (cause: unknown, signal: AbortSignal | undefined): MetricErrorInfo => {
  if (cause instanceof AttestMetricError) {
    return {
      code: cause.code,
      message: cause.message,
      details: cause.details === undefined ? undefined : toJson(cause.details),
    };
  }

  if (signal?.aborted === true) {
    return { code: 'metric_cancelled', message: 'Judge evaluation was cancelled.' };
  }

  return {
    code: 'judge_provider_error',
    message:
      cause instanceof Error ? cause.message : 'Judge provider call failed for an unknown reason.',
  };
};

/**
 * Evaluates one judge rubric while keeping provider faults distinct
 * from genuine failing scores. Full prompt/response evidence is retained for completed and attempted calls.
 */
const evaluateJudgeMetric = async (
  definition: JudgeMetricDefinition,
  context: CompletedMetricContext,
  options: EvaluateJudgeMetricOptions,
): Promise<StoredMetricEvaluation> => {
  const startedAt = performance.now();
  const document = buildEvaluationDocument(context);

  const request: JudgeRequest = {
    model: definition.model,
    rubric: definition.rubric,
    document: {
      input: document.input,
      output: document.output,
      expected: document.expected,
      traceSummary: summarizeTraceForJudge(document.trace),
    },
  };

  const scope = {
    client: options.client,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS,
  };

  try {
    options.signal?.throwIfAborted();

    if (options.cache === undefined) {
      const outcome = await options.client.scoreRubric(request, scope);

      return judgeEvaluation(
        definition,
        outcome,
        toJson(outcome.record),
        performance.now() - startedAt,
      );
    }

    const { outcome, source, key } = await resolveThroughJudgeCache(options.cache, request, scope);
    const judgeIo = toJson({ ...outcome.record, cache: source, key });

    return judgeEvaluation(definition, outcome, judgeIo, performance.now() - startedAt);
  } catch (error: unknown) {
    return metricError(
      definition,
      judgeFailure(error, options.signal),
      performance.now() - startedAt,
    );
  }
};

export { evaluateJudgeMetric };
