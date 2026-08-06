import { Kysely } from 'kysely';
import { monotonicFactory } from 'ulid';

import { canonicalStringify, contentHash } from './internal/canonical-json.js';
import {
  computeSummary,
  toCaseRecord,
  toMetricEvaluation,
  toRunRecord,
} from './internal/row-mapping.js';
import { runInMigrationQueue } from './internal/migration-queue.js';
import { toSpanAttribute } from './internal/span-attribute.js';
import { executeWrite } from './internal/write-operation.js';
import { createSqliteDialect, openSqliteHandle, type SqliteHandle } from './database.js';
import { migrateToLatest } from './migrations.js';
import type { Database } from './schema.js';
import {
  StoreError,
  type CaseRecord,
  type RunMetadata,
  type RunRecord,
  type RunStore,
  type RunStatus,
  type StoredCaseExecution,
  type StoredMetricEvaluation,
} from './types.js';

const createUlid = monotonicFactory();

const assertWritableRun = async (database: Kysely<Database>, runId: string): Promise<void> => {
  const run = await database
    .selectFrom('runs')
    .select(['id', 'status'])
    .where('id', '=', runId)
    .executeTakeFirst();
  if (!run) {
    throw new StoreError('RUN_NOT_FOUND', `Run ${runId} was not found.`);
  }

  if (run.status !== 'running') {
    throw new StoreError('RUN_FINALIZED', `Run ${runId} is already finalized.`);
  }
};

class SqliteRunStore implements RunStore {
  readonly #database: Kysely<Database>;

  constructor(database: Kysely<Database>) {
    this.#database = database;
  }

  /** Creates a running record with a UTC timestamp and ULID identity. */
  async createRun(metadata: RunMetadata): Promise<RunRecord> {
    return executeWrite('Could not create the run.', async () => {
      const record: RunRecord = {
        ...metadata,
        id: createUlid(),
        createdAt: new Date().toISOString(),
        status: 'running',
      };
      await this.#database
        .insertInto('runs')
        .values({
          id: record.id,
          created_at: record.createdAt,
          finished_at: null,
          status: record.status,
          config_version: record.configVersion,
          config_hash: record.configHash,
          config_json: record.configJson,
          git_sha: record.gitSha ?? null,
          git_branch: record.gitBranch ?? null,
          labels_json: record.labels ? canonicalStringify(record.labels) : null,
          summary_json: null,
        })
        .execute();
      return record;
    });
  }

  /** Atomically persists a case and all child records while its run remains mutable. */
  async recordCase(
    runId: string,
    execution: StoredCaseExecution,
    evaluations: StoredMetricEvaluation[],
  ): Promise<void> {
    await executeWrite('Could not record the case.', async () =>
      this.#database.transaction().execute(async (database) => {
        await assertWritableRun(database, runId);
        const caseRowId = createUlid();
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
            response_json:
              execution.response === undefined ? null : canonicalStringify(execution.response),
            response_warnings_json: execution.responseWarnings
              ? canonicalStringify(execution.responseWarnings)
              : null,
            invocation_error_json: execution.invocationError
              ? canonicalStringify(execution.invocationError)
              : null,
            trace_json: execution.trace ? canonicalStringify(execution.trace) : null,
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

        const spans = execution.trace?.spans ?? [];
        if (spans.length === 0) {
          return;
        }

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
      }),
    );
  }

  /** Finalizes a run once and persists summary counts using the documented verdict rule. */
  async finalizeRun(runId: string, status: Exclude<RunStatus, 'running'>): Promise<RunRecord> {
    await executeWrite('Could not finalize the run.', async () =>
      this.#database.transaction().execute(async (database) => {
        await assertWritableRun(database, runId);
        const cases = await database
          .selectFrom('cases')
          .select(['id', 'outcome'])
          .where('run_id', '=', runId)
          .execute();
        const caseIds = cases.map((caseRow) => caseRow.id);
        const metrics =
          caseIds.length === 0
            ? []
            : await database
                .selectFrom('metric_results')
                .select(['case_row_id', 'status', 'pass'])
                .where('case_row_id', 'in', caseIds)
                .execute();
        await database
          .updateTable('runs')
          .set({
            status,
            finished_at: new Date().toISOString(),
            summary_json: canonicalStringify(computeSummary(cases, metrics)),
          })
          .where('id', '=', runId)
          .execute();
      }),
    );
    return this.getRun(runId);
  }

  /** Loads a run while preserving optional metadata and summary fields. */
  async getRun(runId: string): Promise<RunRecord> {
    const row = await this.#database
      .selectFrom('runs')
      .selectAll()
      .where('id', '=', runId)
      .executeTakeFirst();
    if (!row) {
      throw new StoreError('RUN_NOT_FOUND', `Run ${runId} was not found.`);
    }

    return toRunRecord(row);
  }

  /** Lists runs in deterministic newest-first order. */
  async listRuns(options: { limit?: number } = {}): Promise<RunRecord[]> {
    let query = this.#database
      .selectFrom('runs')
      .selectAll()
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc');
    if (options.limit !== undefined) {
      query = query.limit(options.limit);
    }

    return (await query.execute()).map(toRunRecord);
  }

  /** Rehydrates canonical case JSON and joins metric rows without altering unknown fields. */
  async getCaseResults(runId: string): Promise<CaseRecord[]> {
    await this.getRun(runId);
    const cases = await this.#database
      .selectFrom('cases')
      .selectAll()
      .where('run_id', '=', runId)
      .orderBy('id')
      .execute();
    const caseIds = cases.map((caseRow) => caseRow.id);
    const metrics =
      caseIds.length === 0
        ? []
        : await this.#database
            .selectFrom('metric_results')
            .selectAll()
            .where('case_row_id', 'in', caseIds)
            .orderBy('id')
            .execute();
    const metricsByCase = new Map<string, StoredMetricEvaluation[]>();
    for (const metric of metrics) {
      const caseMetrics = metricsByCase.get(metric.case_row_id) ?? [];
      caseMetrics.push(toMetricEvaluation(metric));
      metricsByCase.set(metric.case_row_id, caseMetrics);
    }

    return cases.map((caseRow) => toCaseRecord(caseRow, metricsByCase.get(caseRow.id) ?? []));
  }

  /** Closes Kysely and its owned SQLite handle. */
  async close(): Promise<void> {
    await this.#database.destroy();
  }
}

/**
 * Opens, migrates, and returns a local run store; failures are normalized for CLI handling
 * (PLAN 1S.1–1S.3).
 */
const openRunStore = async (path: string): Promise<RunStore> => {
  return runInMigrationQueue(path, async (resolvedPath) => {
    let handle: SqliteHandle | undefined;
    try {
      handle = await openSqliteHandle(resolvedPath);
      await migrateToLatest(handle);
      return new SqliteRunStore(new Kysely<Database>({ dialect: createSqliteDialect(handle) }));
    } catch (error) {
      await handle?.close();
      if (error instanceof StoreError) {
        throw error;
      }

      throw new StoreError('OPEN_FAILED', `Could not open run store at ${resolvedPath}.`, {
        cause: error,
      });
    }
  });
};

export { StoreError, openRunStore, type RunStore };
