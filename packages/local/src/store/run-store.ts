import { z } from 'zod';

import { resolve } from 'node:path';

import { Kysely } from 'kysely';

import {
  canonicalStringify,
  pageQuerySchema,
  type PageQuery,
  type RunPage,
  type CaseSummaryPage,
  StoreError,
  type AttestStore,
  type CaseRecord,
  type CaseSummary,
  type RunIdentity,
  type RunMetadata,
  type RunRecord,
  type RunStatus,
  type RunStore,
  type StoredMetricEvaluation,
} from '@attest/core';

import { createCacheStore } from './cache.js';
import { recordCaseTransaction, validateCaseRecordInput } from './internal/case-recording.js';
import { createSqliteDialect } from './internal/kysely-sqlite-dialect.js';
import { createUlid } from './internal/create-ulid.js';
import { createLock } from './internal/promise-lock.js';
import { toCaseRecord, toMetricEvaluation, toRunRecord } from './internal/row-mapping.js';
import {
  agentErroredColumn,
  lifecycleFailedColumn,
  rowVerdict,
  summarizeRuns,
} from './internal/run-summary.js';
import { openReadonlySqliteHandle, openSqliteHandle } from './internal/open-sqlite-handle.js';
import type { SqliteHandle } from './internal/sqlite-handle.js';
import { executeStoreOperation } from './internal/store-operation.js';
import { migrateToLatest, validateReadableSchema } from './migration-runner.js';
import type { Database, MetricResultsTable, RunsTable } from './schema.js';

const migrationLocks = new Map<string, ReturnType<typeof createLock>>();

/** Allocates the shared ULID/timestamp pair used by immutable eval metadata and the run store. */
const createRunIdentity = (now: () => Date = () => new Date()): RunIdentity => ({
  id: createUlid(),
  createdAt: now().toISOString(),
});

const loadMetrics = async (
  database: Kysely<Database>,
  caseRowIds: string[],
): Promise<MetricResultsTable[]> =>
  caseRowIds.length === 0
    ? []
    : database
        .selectFrom('metric_results')
        .selectAll()
        .where('case_row_id', 'in', caseRowIds)
        .orderBy('id')
        .execute();

const groupMetrics = (metrics: MetricResultsTable[]): Map<string, StoredMetricEvaluation[]> => {
  const grouped = new Map<string, StoredMetricEvaluation[]>();

  for (const metric of metrics) {
    const values = grouped.get(metric.case_row_id) ?? [];
    values.push(toMetricEvaluation(metric));
    grouped.set(metric.case_row_id, values);
  }

  return grouped;
};

/** Averages finite evaluated metric scores for the lightweight dashboard projection. */
const averageMetricScore = (metrics: MetricResultsTable[]): number | undefined => {
  const scores = metrics.flatMap((metric) =>
    metric.status === 'evaluated' && metric.score !== null ? [metric.score] : [],
  );

  return scores.length === 0
    ? undefined
    : scores.reduce((total, score) => total + score, 0) / scores.length;
};

class SqliteRunStore implements RunStore {
  readonly #database: Kysely<Database>;

  constructor(database: Kysely<Database>) {
    this.#database = database;
  }

  /** Creates a running record with a UTC timestamp and ULID identity. */
  async createRun(
    metadata: RunMetadata,
    identity: RunIdentity = createRunIdentity(),
  ): Promise<RunRecord> {
    return executeStoreOperation('WRITE_FAILED', 'Could not create the run.', async () => {
      const record: RunRecord = {
        ...metadata,
        id: identity.id,
        createdAt: identity.createdAt,
        status: 'running',
      };

      await this.#database
        .insertInto('runs')
        .values({
          id: record.id,
          created_at: record.createdAt,
          finished_at: null,
          status: record.status,
          schema_id: record.schemaId,
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

  /** Atomically persists one runtime-validated case and all of its child evidence. */
  // BOUNDARY: Untrusted execution and metric submissions are decoded with store owner schemas before persistence.
  async recordCase(runId: string, execution: unknown, evaluations: unknown): Promise<void> {
    const parsed = validateCaseRecordInput(execution, evaluations);
    await executeStoreOperation('WRITE_FAILED', 'Could not record the case.', async () =>
      this.#database
        .transaction()
        .execute((database) =>
          recordCaseTransaction(database, runId, parsed.execution, parsed.evaluations),
        ),
    );
  }

  /** Finalizes once; same-status calls return the stored record for retry-safe acknowledgement. */
  async finalizeRun(runId: string, status: Exclude<RunStatus, 'running'>): Promise<RunRecord> {
    await executeStoreOperation('WRITE_FAILED', 'Could not finalize the run.', async () =>
      this.#database.transaction().execute(async (database) => {
        const run = await database
          .selectFrom('runs')
          .select('status')
          .where('id', '=', runId)
          .executeTakeFirst();

        if (!run) throw new StoreError('RUN_NOT_FOUND', `Run ${runId} was not found.`);

        if (run.status !== 'running') {
          if (run.status === status) return;
          throw new StoreError(
            'RUN_FINALIZED',
            `Run ${runId} is already finalized as ${run.status}.`,
          );
        }

        const summaryOf = await summarizeRuns(database, [runId]);

        await database
          .updateTable('runs')
          .set({
            status,
            finished_at: new Date().toISOString(),
            summary_json: canonicalStringify(summaryOf(runId)),
          })
          .where('id', '=', runId)
          .execute();
      }),
    );

    return this.getRun(runId);
  }

  /** Loads the run row, so case reads can confirm the run exists without totalling it. */
  async #getRunRow(runId: string): Promise<RunsTable> {
    const row = await this.#database
      .selectFrom('runs')
      .selectAll()
      .where('id', '=', runId)
      .executeTakeFirst();

    if (!row) throw new StoreError('RUN_NOT_FOUND', `Run ${runId} was not found.`);

    return row;
  }

  /**
   * Builds run records with totals recomputed from case rows. Runs finalized before the shared
   * verdict rule hold stale summary_json, so no read uses it. Running runs have no totals yet.
   */
  async #runRecordMapper(rows: RunsTable[]): Promise<(row: RunsTable) => RunRecord> {
    const terminal = rows.filter((row) => row.status !== 'running');

    const summaryOf = await summarizeRuns(
      this.#database,
      terminal.map((row) => row.id),
    );

    return (row) => toRunRecord(row, row.status === 'running' ? undefined : summaryOf(row.id));
  }

  /** Loads one run with its metadata and recomputed totals. */
  async getRun(runId: string): Promise<RunRecord> {
    const row = await this.#getRunRow(runId);
    const toRecord = await this.#runRecordMapper([row]);

    return toRecord(row);
  }

  /** Lists runs in deterministic newest-first order. */
  async listRuns(query: PageQuery = {}): Promise<RunPage> {
    const limit = this.#pageLimit(query);

    let select = this.#database
      .selectFrom('runs')
      .selectAll()
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1);

    if (query.cursor !== undefined) {
      const anchor = await this.#database
        .selectFrom('runs')
        .select(['created_at', 'id'])
        .where('id', '=', query.cursor)
        .executeTakeFirst();

      if (anchor === undefined)
        throw new StoreError('INVALID_CURSOR', `Run cursor ${query.cursor} is unknown.`);
      select = select.where((eb) =>
        eb.or([
          eb('created_at', '<', anchor.created_at),
          eb.and([eb('created_at', '=', anchor.created_at), eb('id', '<', anchor.id)]),
        ]),
      );
    }

    const rows = await select.execute();
    const pageRows = rows.slice(0, limit);
    const items = pageRows.map(await this.#runRecordMapper(pageRows));

    return rows.length > limit ? { items, nextCursor: pageRows.at(-1)?.id } : { items };
  }

  #pageLimit(query: PageQuery): number {
    const parsed = pageQuerySchema.shape.limit.safeParse(query.limit);

    if (!parsed.success)
      throw new StoreError(
        'INVALID_LIMIT',
        parsed.error.issues[0]?.message ?? parsed.error.message,
      );

    return parsed.data;
  }

  /** Rehydrates case blobs after the caller has established the parent run. */
  async #loadCaseResults(runId: string): Promise<CaseRecord[]> {
    const cases = await this.#database
      .selectFrom('cases')
      .selectAll()
      .where('run_id', '=', runId)
      .orderBy('id')
      .execute();

    const metrics = groupMetrics(
      await loadMetrics(
        this.#database,
        cases.map((row) => row.id),
      ),
    );

    return cases.map((row) => toCaseRecord(row, metrics.get(row.id) ?? []));
  }

  /** Loads a run and its cases with one parent lookup for aggregate consumers. */
  async getRunWithCases(runId: string): Promise<{ run: RunRecord; cases: CaseRecord[] }> {
    const run = await this.getRun(runId);

    return { run, cases: await this.#loadCaseResults(runId) };
  }

  /** Loads one case detail while preserving distinct missing-run and missing-case semantics. */
  async getCase(runId: string, suiteName: string, caseId: string): Promise<CaseRecord> {
    await this.#getRunRow(runId);

    const row = await this.#database
      .selectFrom('cases')
      .selectAll()
      .where('run_id', '=', runId)
      .where('suite_name', '=', suiteName)
      .where('case_id', '=', caseId)
      .executeTakeFirst();

    if (!row)
      throw new StoreError(
        'CASE_NOT_FOUND',
        `Case ${suiteName}/${caseId} was not found in run ${runId}.`,
      );
    const metrics = await loadMetrics(this.#database, [row.id]);

    return toCaseRecord(row, metrics.map(toMetricEvaluation));
  }

  /** Returns a row-id cursor page without selecting request, response, trace, or diagnostic blobs. */
  async listCaseSummaries(runId: string, query: PageQuery = {}): Promise<CaseSummaryPage> {
    await this.#getRunRow(runId);
    const limit = this.#pageLimit(query);

    if (query.cursor !== undefined) {
      const cursor = await this.#database
        .selectFrom('cases')
        .select('run_id')
        .where('id', '=', query.cursor)
        .executeTakeFirst();

      if (cursor?.run_id !== runId) {
        throw new StoreError(
          'INVALID_CURSOR',
          `Case summary cursor ${query.cursor} does not belong to run ${runId}.`,
        );
      }
    }

    let select = this.#database
      .selectFrom('cases')
      .select([
        'id',
        'case_id',
        'suite_name',
        'outcome',
        'started_at',
        'duration_ms',
        'expected_metrics_json',
        lifecycleFailedColumn,
        agentErroredColumn,
      ])
      .where('run_id', '=', runId)
      .orderBy('id')
      .limit(limit + 1);

    if (query.cursor !== undefined) select = select.where('id', '>', query.cursor);
    const rows = await select.execute();
    const pageRows = rows.slice(0, limit);

    const metrics = await loadMetrics(
      this.#database,
      pageRows.map((row) => row.id),
    );

    const metricsByCase = new Map<string, MetricResultsTable[]>();

    for (const metric of metrics) {
      const values = metricsByCase.get(metric.case_row_id) ?? [];
      values.push(metric);
      metricsByCase.set(metric.case_row_id, values);
    }

    const items = pageRows.map((row) => {
      const caseMetrics = metricsByCase.get(row.id) ?? [];
      const expected = z.array(z.string()).parse(JSON.parse(row.expected_metrics_json));
      const score = averageMetricScore(caseMetrics);

      const item: CaseSummary = {
        caseId: row.case_id,
        suiteName: row.suite_name,
        outcome: row.outcome,
        verdict: rowVerdict(row, caseMetrics),
        startedAt: row.started_at,
        durationMs: row.duration_ms,
        metricCounts: {
          expected: expected.length,
          evaluated: caseMetrics.filter((metric) => metric.status === 'evaluated').length,
          passed: caseMetrics.filter((metric) => metric.status === 'evaluated' && metric.pass === 1)
            .length,
          errors: caseMetrics.filter((metric) => metric.status === 'error').length,
        },
      };

      if (score !== undefined) item.score = score;

      return item;
    });

    return rows.length > limit ? { items, nextCursor: pageRows.at(-1)?.id } : { items };
  }

  /** Closes Kysely and its owned SQLite handle. */
  async close(): Promise<void> {
    await this.#database.destroy();
  }
}

/** Opens the explicit run/cache context while serializing schema setup by resolved path. */
const openStore = async (path: string): Promise<AttestStore> => {
  const resolvedPath = resolve(path);
  const lock = migrationLocks.get(resolvedPath) ?? createLock();
  migrationLocks.set(resolvedPath, lock);
  const release = await lock.acquire();
  let handle: SqliteHandle | undefined;

  try {
    handle = await openSqliteHandle(resolvedPath);
    await migrateToLatest(handle);
    const database = new Kysely<Database>({ dialect: createSqliteDialect(handle) });
    const runs = new SqliteRunStore(database);

    return { runs, cache: createCacheStore(database), close: () => runs.close() };
  } catch (error) {
    await handle?.close();
    throw error;
  } finally {
    release();
  }
};

/**
 * Opens an existing store read-only: no migrations, no creating fallback, and a live writer's
 * committed rows stay visible. Readers of copied snapshots and of registered projects use it.
 */
const openReadonlyRunStore = async (path: string): Promise<RunStore> => {
  let handle: SqliteHandle | undefined;

  try {
    handle = await openReadonlySqliteHandle(resolve(path));
    await validateReadableSchema(handle);

    return new SqliteRunStore(new Kysely<Database>({ dialect: createSqliteDialect(handle) }));
  } catch (error) {
    await handle?.close();
    throw error;
  }
};

export { createRunIdentity, openReadonlyRunStore, openStore, type RunStore };
