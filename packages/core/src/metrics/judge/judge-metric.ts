import { performance } from 'node:perf_hooks';

import type { JsonValue, MetricDefinition, MetricResult } from '@attest/contracts';

import { buildEvaluationDocument } from '../evaluation-document.js';
import { AttestMetricError } from '../errors.js';
import type { MetricContext, MetricEvaluation } from '../metric-evaluation.js';
import type { JudgeClient, JudgeRecord, JudgeUsage } from './judge-client.js';
import { summarizeTraceForJudge } from './rubric-prompt.js';

const DEFAULT_JUDGE_TIMEOUT_MS = 60_000;

/** Narrows the shared metric contract to rubric-based judge definitions. */
type JudgeMetricDefinition = Extract<MetricDefinition, { type: 'judge' }>;

/** Supplies the provider boundary and resource controls owned by the enclosing run. */
type EvaluateJudgeMetricOptions = {
  client: JudgeClient;
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
});

/** Creates the shared no-output short circuit without invoking a provider. */
const skippedJudgeEvaluation = (
  definition: JudgeMetricDefinition,
  durationMs: number,
): MetricEvaluation => ({
  metricName: definition.name,
  kind: 'judge',
  status: 'error',
  error: {
    code: 'skipped_no_output',
    message: 'Judge was not invoked because the case execution produced no completed output.',
  },
  durationMs,
});

/**
 * Evaluates one judge rubric according to metric contract §3 while keeping provider faults distinct
 * from genuine failing scores. Full prompt/response evidence is retained only on completed calls.
 */
const evaluateJudgeMetric = async (
  definition: JudgeMetricDefinition,
  context: MetricContext,
  options: EvaluateJudgeMetricOptions,
): Promise<MetricEvaluation> => {
  const startedAt = performance.now();
  if (context.execution.outcome !== 'completed') {
    return skippedJudgeEvaluation(definition, performance.now() - startedAt);
  }
  if (options.signal?.aborted) {
    return {
      metricName: definition.name,
      kind: 'judge',
      status: 'error',
      error: { code: 'judge_provider_error', message: 'Judge evaluation was cancelled.' },
      durationMs: performance.now() - startedAt,
    };
  }

  const document = buildEvaluationDocument(context);
  try {
    const outcome = await options.client.scoreRubric(
      {
        model: definition.model,
        rubric: definition.rubric,
        document: {
          input: document.input,
          output: document.output,
          expected: document.expected,
          traceSummary: summarizeTraceForJudge(document.trace),
        },
      },
      { timeoutMs: options.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS, signal: options.signal },
    );
    const threshold = definition.threshold ?? 0.5;
    const result: MetricResult = {
      score: outcome.verdict.score,
      pass: outcome.verdict.score >= threshold,
      rationale: outcome.verdict.rationale,
      ...(outcome.record.usage === undefined
        ? {}
        : { details: { usage: serializeJudgeUsage(outcome.record.usage) } }),
    };

    return {
      metricName: definition.name,
      kind: 'judge',
      status: 'evaluated',
      result,
      judgeIo: serializeJudgeRecord(outcome.record),
      durationMs: performance.now() - startedAt,
    };
  } catch (error: unknown) {
    const unparseable =
      error instanceof AttestMetricError && error.code === 'judge_unparseable_response';
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
        code: unparseable ? 'judge_unparseable_response' : 'judge_provider_error',
        message,
        ...(unparseable && error.details !== undefined ? { details: error.details } : {}),
      },
      durationMs: performance.now() - startedAt,
    };
  }
};

export { evaluateJudgeMetric, type EvaluateJudgeMetricOptions, type JudgeMetricDefinition };
