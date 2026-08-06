import type { Transaction } from 'kysely';
import { monotonicFactory } from 'ulid';

import type { Database } from '../schema.js';
import {
  StoreError,
  type CaseRecord,
  type StoredCaseExecution,
  type StoredInvocationErrorCode,
  type StoredMetricEvaluation,
} from '../types.js';
import { canonicalStringify, contentHash } from './canonical-json.js';
import { toCaseRecord, toMetricEvaluation } from './row-mapping.js';
import { toSpanAttribute } from './span-attribute.js';

const createUlid = monotonicFactory();
const invocationErrorCodes: StoredInvocationErrorCode[] = [
  'spawn_failed',
  'timeout',
  'output_cap_exceeded',
  'nonzero_exit',
  'http_status',
  'network',
  'invalid_envelope',
  'cancelled',
];

/** Rejects contradictory runner terminal records before any durable write is attempted. */
const validateStoredCaseExecution = (execution: StoredCaseExecution): void => {
  const candidate = execution as unknown as Record<string, unknown>;
  const violations: string[] = [];
  if (!Array.isArray(candidate.warnings)) violations.push('warnings must be an array');
  if (!candidate.diagnostics || typeof candidate.diagnostics !== 'object') {
    violations.push('diagnostics must be an object');
  }
  if (!Array.isArray(candidate.attempts)) violations.push('attempts must be an array');
  if (!Array.isArray(candidate.expectedMetrics))
    violations.push('expectedMetrics must be an array');

  if (candidate.outcome === 'completed') {
    if (!Object.hasOwn(candidate, 'response') || candidate.response === undefined) {
      violations.push('completed outcome requires response');
    }
    if (Object.hasOwn(candidate, 'errorCode'))
      violations.push('completed outcome forbids errorCode');
    if (Object.hasOwn(candidate, 'errorMessage')) {
      violations.push('completed outcome forbids errorMessage');
    }
  } else {
    if (!['invocation_error', 'timeout', 'cancelled'].includes(String(candidate.outcome))) {
      violations.push('outcome must be a supported terminal discriminant');
    }
    if (!invocationErrorCodes.includes(candidate.errorCode as StoredInvocationErrorCode)) {
      violations.push('non-completed outcome requires a valid errorCode');
    }
    if (typeof candidate.errorMessage !== 'string') {
      violations.push('non-completed outcome requires errorMessage');
    }
    if (Object.hasOwn(candidate, 'response'))
      violations.push('non-completed outcome forbids response');
    if (Object.hasOwn(candidate, 'trace')) violations.push('non-completed outcome forbids trace');
  }

  if (violations.length > 0) {
    throw new StoreError('INVALID_RECORD', `Invalid case record: ${violations.join('; ')}.`);
  }
};

const executionHash = (
  execution: StoredCaseExecution,
  evaluations: StoredMetricEvaluation[],
): string => contentHash({ execution, evaluations });

const toExecution = (record: CaseRecord): StoredCaseExecution => {
  const shared = {
    caseId: record.caseId,
    suiteName: record.suiteName,
    request: record.request,
    startedAt: record.startedAt,
    durationMs: record.durationMs,
    warnings: record.warnings,
    diagnostics: record.diagnostics,
    attempts: record.attempts,
    expectedMetrics: record.expectedMetrics,
  };
  return record.outcome === 'completed'
    ? { ...shared, outcome: 'completed', response: record.response, trace: record.trace }
    : {
        ...shared,
        outcome: record.outcome,
        errorCode: record.errorCode,
        errorMessage: record.errorMessage,
      };
};

const readExistingCase = async (
  database: Transaction<Database>,
  runId: string,
  execution: StoredCaseExecution,
): Promise<{ inputHash: string; record: CaseRecord } | undefined> => {
  const row = await database
    .selectFrom('cases')
    .selectAll()
    .where('run_id', '=', runId)
    .where('suite_name', '=', execution.suiteName)
    .where('case_id', '=', execution.caseId)
    .executeTakeFirst();
  if (!row) return undefined;
  const metrics = await database
    .selectFrom('metric_results')
    .selectAll()
    .where('case_row_id', '=', row.id)
    .orderBy('id')
    .execute();
  return {
    inputHash: row.input_hash,
    record: toCaseRecord(row, metrics.map(toMetricEvaluation)),
  };
};

/** Persists one validated case transaction with post-commit-crash idempotent replay handling. */
const recordCaseTransaction = async (
  database: Transaction<Database>,
  runId: string,
  execution: StoredCaseExecution,
  evaluations: StoredMetricEvaluation[],
): Promise<void> => {
  validateStoredCaseExecution(execution);
  const run = await database
    .selectFrom('runs')
    .select('status')
    .where('id', '=', runId)
    .executeTakeFirst();
  if (!run) throw new StoreError('RUN_NOT_FOUND', `Run ${runId} was not found.`);

  const existing = await readExistingCase(database, runId, execution);
  if (existing) {
    const sameInput = existing.inputHash === contentHash(execution.request);
    const sameExecution =
      executionHash(toExecution(existing.record), existing.record.metrics) ===
      executionHash(execution, evaluations);
    if (sameInput && sameExecution) return;
    throw new StoreError(
      'CASE_CONFLICT',
      `Case ${execution.suiteName}/${execution.caseId} conflicts with its stored record.`,
    );
  }
  if (run.status !== 'running')
    throw new StoreError('RUN_FINALIZED', `Run ${runId} is already finalized.`);

  const caseRowId = createUlid();
  const completed = execution.outcome === 'completed';
  await database
    .insertInto('cases')
    .values({
      id: caseRowId,
      run_id: runId,
      case_id: execution.caseId,
      suite_name: execution.suiteName,
      outcome: execution.outcome,
      started_at: execution.startedAt,
      duration_ms: execution.durationMs,
      input_hash: contentHash(execution.request),
      request_json: canonicalStringify(execution.request),
      response_json: completed ? canonicalStringify(execution.response) : null,
      error_code: completed ? null : execution.errorCode,
      error_message: completed ? null : execution.errorMessage,
      warnings_json: canonicalStringify(execution.warnings),
      diagnostics_json: canonicalStringify(execution.diagnostics),
      attempts_json: canonicalStringify(execution.attempts),
      expected_metrics_json: canonicalStringify(execution.expectedMetrics),
      trace_json: completed && execution.trace ? canonicalStringify(execution.trace) : null,
    })
    .execute();

  if (evaluations.length > 0) {
    await database
      .insertInto('metric_results')
      .values(
        evaluations.map((evaluation) => ({
          id: createUlid(),
          case_row_id: caseRowId,
          metric_name: evaluation.metricName,
          kind: evaluation.kind,
          status: evaluation.status,
          score: evaluation.score ?? null,
          pass: evaluation.pass === undefined ? null : Number(evaluation.pass),
          rationale: evaluation.rationale ?? null,
          details_json:
            evaluation.details === undefined ? null : canonicalStringify(evaluation.details),
          error_json: evaluation.error ? canonicalStringify(evaluation.error) : null,
          judge_io_json:
            evaluation.judgeIo === undefined ? null : canonicalStringify(evaluation.judgeIo),
          duration_ms: evaluation.durationMs ?? null,
        })),
      )
      .execute();
  }

  const spans = completed ? (execution.trace?.spans ?? []) : [];
  if (spans.length > 0) {
    await database
      .insertInto('spans')
      .values(
        spans.map((span) => ({
          id: createUlid(),
          case_row_id: caseRowId,
          span_id: span.span_id,
          parent_span_id: span.parent_span_id,
          kind: span.kind,
          name: span.name,
          start_time: span.start_time,
          end_time: span.end_time,
          status: span.status?.code ?? null,
          tool_name: toSpanAttribute(span.attributes?.['gen_ai.tool.name']),
          model_name: toSpanAttribute(span.attributes?.['gen_ai.request.model']),
        })),
      )
      .execute();
  }
};

export { recordCaseTransaction, validateStoredCaseExecution };
