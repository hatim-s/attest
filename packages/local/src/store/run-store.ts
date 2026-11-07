import { createLock } from './internal/promise-lock.js';
import { canonicalTime } from './internal/dashboard-boundary.js';
import { parseWithSchemaSync } from '@attest/contracts';
import * as Schema from 'effect/Schema';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Semaphore from 'effect/Semaphore';
import { StoreScope } from './internal/store-scope.js';
import { storeCall, storeDecode, finishStoreCleanup } from './internal/store-effect.js';

import { resolve } from 'node:path';

import { Kysely } from 'kysely';

import {
  canonicalStringify,
  plannedCaseSelection,
  parsePageLimit,
  type PageQuery,
  StoreError,
  type AttestStore,
  type CaseSummary,
  type RunIdentity,
  type RunMetadata,
  type RunRecord,
  type RunStatus,
  type RunStore,
  type StoredMetricEvaluation,
} from '@attest/core';

import {
  seedSuiteTotals,
  finalizeSuiteTotals,
  summarizeRuns,
} from './internal/dashboard-totals.js';
import { DashboardReads } from './internal/dashboard-reads.js';
import { createCacheStore } from './cache.js';
import { recordCaseTransaction, validateCaseRecordInput } from './internal/case-recording.js';
import { createSqliteDialect } from './internal/kysely-sqlite-dialect.js';
import { createUlid } from './internal/create-ulid.js';

import { toCaseRecord, toMetricEvaluation, toRunRecord } from './internal/row-mapping.js';
import { openReadonlySqliteHandle, openSqliteHandle } from './internal/open-sqlite-handle.js';

import { migrateToLatest, validateReadableSchema } from './migration-runner.js';
import type { Database, MetricResultsTable, RunsTable } from './schema.js';

const databaseLocks = new Map<string, ReturnType<typeof createLock>>();

const migrationLocks = new Map<string, Semaphore.Semaphore>();

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

  /** Each composed read uses one WAL snapshot across its bounded statements. */
  #dashboardRead = <T>(read: (dashboard: DashboardReads) => Effect.Effect<T, StoreError>) =>
    Effect.uninterruptible(
      Effect.gen(
        function* (this: SqliteRunStore) {
          const transaction = yield* storeCall(
            'READ_FAILED',
            'Could not start dashboard snapshot.',
            () => this.#database.startTransaction().setAccessMode('read only').execute(),
          );

          const primary = yield* Effect.exit(read(new DashboardReads(transaction)));

          const cleanup = yield* Effect.exit(
            storeCall('READ_FAILED', 'Could not release dashboard snapshot.', () =>
              Exit.isSuccess(primary)
                ? transaction.commit().execute()
                : transaction.rollback().execute(),
            ),
          );

          return yield* finishStoreCleanup(primary, cleanup);
        }.bind(this),
      ),
    );
  getProjectOverview: RunStore['getProjectOverview'] = () =>
    this.#dashboardRead((d) => d.getProjectOverview());

  listEvals: RunStore['listEvals'] = (query) => this.#dashboardRead((d) => d.listEvals(query));
  listEvalRuns: RunStore['listEvalRuns'] = (suite, query) =>
    this.#dashboardRead((d) => d.listEvalRuns(suite, query));
  getEvalCaseWindow: RunStore['getEvalCaseWindow'] = (suite, query) =>
    this.#dashboardRead((d) => d.getEvalCaseWindow(suite, query));
  getCaseHistory: RunStore['getCaseHistory'] = (suite, caseId, query) =>
    this.#dashboardRead((d) => d.getCaseHistory(suite, caseId, query));
  getActivity: RunStore['getActivity'] = (query) =>
    this.#dashboardRead((d) => d.getActivity(query));
  listRunSuites: RunStore['listRunSuites'] = (id) =>
    this.#dashboardRead((d) => d.listRunSuites(id));

  /** Creates a running record with a UTC timestamp and ULID identity. */
  createRun = Effect.fn('SqliteRunStore.createRun')(
    function* (
      this: SqliteRunStore,
      metadata: RunMetadata,
      identity: RunIdentity = createRunIdentity(),
    ) {
      let plan;

      try {
        plan = plannedCaseSelection(metadata.schemaId, metadata.configJson);
      } catch (cause) {
        return yield* Effect.fail(
          new StoreError('INVALID_RECORD', `Invalid selection config for run ${identity.id}.`, {
            cause,
          }),
        );
      }

      const createdOrder = yield* storeDecode('Could not decode store data.', () =>
        canonicalTime(identity.createdAt, 'INVALID_RECORD'),
      );

      return yield* storeCall('WRITE_FAILED', 'Could not create the run.', async () => {
        const record: RunRecord = {
          ...metadata,
          id: identity.id,
          createdAt: identity.createdAt,
          status: 'running',
        };

        await this.#database.transaction().execute(async (database) => {
          await database
            .insertInto('runs')
            .values({
              id: record.id,
              created_at: record.createdAt,
              created_order: createdOrder,
              selection_known: 0,
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

          await seedSuiteTotals(database, record, plan);
        });

        return record;
      }).pipe(Effect.uninterruptible);
    }.bind(this),
  );

  /** Atomically persists one runtime-validated case and all of its child evidence. */
  // BOUNDARY: Untrusted execution and metric submissions are decoded with store owner schemas before persistence.
  recordCase = Effect.fn('SqliteRunStore.recordCase')(
    // BOUNDARY: Store submissions are decoded before opening the write transaction.
    function* (this: SqliteRunStore, runId: string, execution: unknown, evaluations: unknown) {
      const parsed = yield* storeDecode('Invalid case record.', () =>
        validateCaseRecordInput(execution, evaluations),
      );

      yield* storeCall('WRITE_FAILED', 'Could not record the case.', async () =>
        this.#database
          .transaction()
          .execute((database) =>
            recordCaseTransaction(database, runId, parsed.execution, parsed.evaluations),
          ),
      ).pipe(Effect.uninterruptible);
    }.bind(this),
  );

  /** Finalizes once; same-status calls return the stored record for retry-safe acknowledgement. */
  finalizeRun = Effect.fn('SqliteRunStore.finalizeRun')(
    function* (this: SqliteRunStore, runId: string, status: Exclude<RunStatus, 'running'>) {
      yield* storeCall('WRITE_FAILED', 'Could not finalize the run.', async () =>
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

          const row = await database
            .selectFrom('runs')
            .selectAll()
            .where('id', '=', runId)
            .executeTakeFirstOrThrow();

          const finishedAt = new Date().toISOString();
          await finalizeSuiteTotals(database, {
            ...toRunRecord(row, undefined),
            status,
            finishedAt,
          });
          const summaryOf = await summarizeRuns(database, [runId]);

          await database
            .updateTable('runs')
            .set({
              status,
              finished_at: finishedAt,
              summary_json: canonicalStringify(summaryOf(runId)),
            })
            .where('id', '=', runId)
            .execute();
        }),
      ).pipe(Effect.uninterruptible);

      return yield* this.getRun(runId);
    }.bind(this),
  );

  /** Loads the run row, so case reads can confirm the run exists without totalling it. */
  #getRunRow = Effect.fn('SqliteRunStore.#getRunRow')(
    function* (this: SqliteRunStore, runId: string) {
      const row = yield* storeCall('READ_FAILED', 'Could not read the store.', () =>
        this.#database.selectFrom('runs').selectAll().where('id', '=', runId).executeTakeFirst(),
      );

      if (!row)
        return yield* Effect.fail(new StoreError('RUN_NOT_FOUND', `Run ${runId} was not found.`));

      return row;
    }.bind(this),
  );

  /**
   * Builds run records from materialized per-eval totals. Running records omit summaries.
   */
  #runRecordMapper = Effect.fn('SqliteRunStore.#runRecordMapper')(
    function* (this: SqliteRunStore, rows: RunsTable[]) {
      const terminal = rows.filter((row) => row.status !== 'running');

      const summaryOf = yield* storeCall('READ_FAILED', 'Could not read the store.', () =>
        summarizeRuns(
          this.#database,
          terminal.map((row) => row.id),
        ),
      );

      return (row: RunsTable) =>
        toRunRecord(row, row.status === 'running' ? undefined : summaryOf(row.id));
    }.bind(this),
  );

  /** Loads one run with its metadata and recomputed totals. */
  getRun = Effect.fn('SqliteRunStore.getRun')(
    function* (this: SqliteRunStore, runId: string) {
      const row = yield* this.#getRunRow(runId);
      const toRecord = yield* this.#runRecordMapper([row]);

      return yield* storeDecode('Could not decode store data.', () => toRecord(row));
    }.bind(this),
  );

  /** Lists runs in deterministic newest-first order. */
  listRuns = Effect.fn('SqliteRunStore.listRuns')(
    function* (this: SqliteRunStore, query: PageQuery = {}) {
      const limit = yield* storeDecode('Could not decode store data.', () => parsePageLimit(query));

      let select = this.#database
        .selectFrom('runs')
        .selectAll()
        .orderBy('created_order', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1);

      if (query.cursor !== undefined) {
        const cursorId = query.cursor;

        const anchor = yield* storeCall('READ_FAILED', 'Could not read the store.', () =>
          this.#database
            .selectFrom('runs')
            .select(['created_order', 'id'])
            .where('id', '=', cursorId)
            .executeTakeFirst(),
        );

        if (anchor === undefined)
          return yield* Effect.fail(
            new StoreError('INVALID_CURSOR', `Run cursor ${query.cursor} is unknown.`),
          );
        select = select.where((eb) =>
          eb.or([
            eb('created_order', '<', anchor.created_order),
            eb.and([eb('created_order', '=', anchor.created_order), eb('id', '<', anchor.id)]),
          ]),
        );
      }

      const rows = yield* storeCall('READ_FAILED', 'Could not read the store.', () =>
        select.execute(),
      );

      const pageRows = rows.slice(0, limit);
      const mapper = yield* this.#runRecordMapper(pageRows);
      const items = yield* storeDecode('Could not decode runs.', () => pageRows.map(mapper));

      return rows.length > limit ? { items, nextCursor: pageRows.at(-1)?.id } : { items };
    }.bind(this),
  );

  /** Rehydrates case blobs after the caller has established the parent run. */
  #loadCaseResults = Effect.fn('SqliteRunStore.#loadCaseResults')(
    function* (this: SqliteRunStore, runId: string) {
      const cases = yield* storeCall('READ_FAILED', 'Could not read the store.', () =>
        this.#database
          .selectFrom('cases')
          .selectAll()
          .where('run_id', '=', runId)
          .orderBy('id')
          .execute(),
      );

      const rawMetrics = yield* storeCall('READ_FAILED', 'Could not read metrics.', () =>
        loadMetrics(
          this.#database,
          cases.map((row) => row.id),
        ),
      );

      const metrics = yield* storeDecode('Could not decode metrics.', () =>
        groupMetrics(rawMetrics),
      );

      return yield* storeDecode('Could not decode cases.', () =>
        cases.map((row) => toCaseRecord(row, metrics.get(row.id) ?? [])),
      );
    }.bind(this),
  );

  /** Loads a run and its cases with one parent lookup for aggregate consumers. */
  getRunWithCases = Effect.fn('SqliteRunStore.getRunWithCases')(
    function* (this: SqliteRunStore, runId: string) {
      const run = yield* this.getRun(runId);

      return { run, cases: yield* this.#loadCaseResults(runId) };
    }.bind(this),
  );

  /** Loads one case detail while preserving distinct missing-run and missing-case semantics. */
  getCase = Effect.fn('SqliteRunStore.getCase')(
    function* (this: SqliteRunStore, runId: string, suiteName: string, caseId: string) {
      yield* this.#getRunRow(runId);

      const row = yield* storeCall('READ_FAILED', 'Could not read the store.', () =>
        this.#database
          .selectFrom('cases')
          .selectAll()
          .where('run_id', '=', runId)
          .where('suite_name', '=', suiteName)
          .where('case_id', '=', caseId)
          .executeTakeFirst(),
      );

      if (!row)
        return yield* Effect.fail(
          new StoreError(
            'CASE_NOT_FOUND',
            `Case ${suiteName}/${caseId} was not found in run ${runId}.`,
          ),
        );

      const metrics = yield* storeCall('READ_FAILED', 'Could not read the store.', () =>
        loadMetrics(this.#database, [row.id]),
      );

      return yield* storeDecode('Could not decode store data.', () =>
        toCaseRecord(row, metrics.map(toMetricEvaluation)),
      );
    }.bind(this),
  );

  /** Returns a row-id cursor page without selecting request, response, trace, or diagnostic blobs. */
  listCaseSummaries = Effect.fn('SqliteRunStore.listCaseSummaries')(
    function* (
      this: SqliteRunStore,
      runId: string,
      query: PageQuery & { suiteName?: string } = {},
    ) {
      yield* this.#getRunRow(runId);
      const limit = yield* storeDecode('Could not decode store data.', () => parsePageLimit(query));

      if (query.cursor !== undefined) {
        const cursorId = query.cursor;

        const cursor = yield* storeCall('READ_FAILED', 'Could not read the store.', () =>
          this.#database
            .selectFrom('cases')
            .select(['run_id', 'suite_name'])
            .where('id', '=', cursorId)
            .executeTakeFirst(),
        );

        if (
          cursor?.run_id !== runId ||
          (query.suiteName !== undefined && cursor?.suite_name !== query.suiteName)
        ) {
          return yield* Effect.fail(
            new StoreError(
              'INVALID_CURSOR',
              `Case summary cursor ${query.cursor} does not belong to run ${runId}.`,
            ),
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
          'verdict',
        ])
        .where('run_id', '=', runId)
        .orderBy('id')
        .limit(limit + 1);

      if (query.suiteName !== undefined) select = select.where('suite_name', '=', query.suiteName);

      if (query.cursor !== undefined) select = select.where('id', '>', query.cursor);

      const rows = yield* storeCall('READ_FAILED', 'Could not read the store.', () =>
        select.execute(),
      );

      const pageRows = rows.slice(0, limit);

      const metrics = yield* storeCall('READ_FAILED', 'Could not read the store.', () =>
        loadMetrics(
          this.#database,
          pageRows.map((row) => row.id),
        ),
      );

      const metricsByCase = new Map<string, MetricResultsTable[]>();

      for (const metric of metrics) {
        const values = metricsByCase.get(metric.case_row_id) ?? [];
        values.push(metric);
        metricsByCase.set(metric.case_row_id, values);
      }

      const items = yield* storeDecode('Could not decode case summaries.', () =>
        pageRows.map((row) => {
          const caseMetrics = metricsByCase.get(row.id) ?? [];

          const expected = parseWithSchemaSync(
            Schema.Array(Schema.String),
            JSON.parse(row.expected_metrics_json),
          );

          const score = averageMetricScore(caseMetrics);

          let item: CaseSummary = {
            caseId: row.case_id,
            suiteName: row.suite_name,
            outcome: row.outcome,
            verdict: row.verdict,
            startedAt: row.started_at,
            durationMs: row.duration_ms,
            metricCounts: {
              expected: expected.length,
              evaluated: caseMetrics.filter((metric) => metric.status === 'evaluated').length,
              passed: caseMetrics.filter(
                (metric) => metric.status === 'evaluated' && metric.pass === 1,
              ).length,
              errors: caseMetrics.filter((metric) => metric.status === 'error').length,
            },
          };

          if (score !== undefined) item = { ...item, score };

          return item;
        }),
      );

      return rows.length > limit ? { items, nextCursor: pageRows.at(-1)?.id } : { items };
    }.bind(this),
  );
}

/** Captures the owner once; operations never require an ambient service or scope. */
const makeRuns = (database: Kysely<Database>, owner: StoreScope): RunStore => {
  const runs = new SqliteRunStore(database);

  return {
    getProjectOverview: (...args) => owner.run(runs.getProjectOverview(...args)),
    listEvals: (...args) => owner.run(runs.listEvals(...args)),
    listEvalRuns: (...args) => owner.run(runs.listEvalRuns(...args)),
    getEvalCaseWindow: (...args) => owner.run(runs.getEvalCaseWindow(...args)),
    getCaseHistory: (...args) => owner.run(runs.getCaseHistory(...args)),
    getActivity: (...args) => owner.run(runs.getActivity(...args)),
    listRunSuites: (...args) => owner.run(runs.listRunSuites(...args)),
    createRun: (...args) => owner.run(runs.createRun(...args)),
    recordCase: (...args) => owner.run(runs.recordCase(...args)),
    finalizeRun: (...args) => owner.run(runs.finalizeRun(...args)),
    getRun: (...args) => owner.run(runs.getRun(...args)),
    listRuns: (...args) => owner.run(runs.listRuns(...args)),
    getCase: (...args) => owner.run(runs.getCase(...args)),
    getRunWithCases: (...args) => owner.run(runs.getRunWithCases(...args)),
    listCaseSummaries: (...args) => owner.run(runs.listCaseSummaries(...args)),
  };
};

/** Transfers one handle only after setup succeeds; failed setup closes immediately. */
const acquireStore = (path: string, owner: StoreScope, mode: 'write' | 'readonly') =>
  Effect.gen(function* () {
    const handle = yield* mode === 'write'
      ? openSqliteHandle(path)
      : openReadonlySqliteHandle(path);

    const initialized = yield* Effect.exit(
      Effect.gen(function* () {
        yield* mode === 'write' ? migrateToLatest(handle) : validateReadableSchema(handle);

        const connectionLock = databaseLocks.get(path) ?? createLock();
        databaseLocks.set(path, connectionLock);

        const database = new Kysely<Database>({
          dialect: createSqliteDialect(handle, connectionLock),
        });

        // Kysely skips driver destruction until initialized, but this handle is already open.
        yield* storeCall('READ_FAILED', 'Could not initialize the store connection.', () =>
          database.connection().execute(() => Promise.resolve()),
        );

        return database;
      }),
    );

    if (Exit.isFailure(initialized)) {
      const cleanup = yield* Effect.exit(
        storeCall('WRITE_FAILED', 'Could not close failed store acquisition.', () =>
          handle.close(),
        ),
      );

      yield* finishStoreCleanup(initialized, cleanup);

      return yield* Effect.failCause(initialized.cause);
    }

    const database = initialized.value;
    yield* owner.register(
      storeCall('WRITE_FAILED', 'Could not close the store.', () => database.destroy()),
    );

    return { runs: makeRuns(database, owner), cache: createCacheStore(database, owner) };
  });

/** Opens one shared run/cache handle per resolved path in the explicit owner. */
const openStore = (path: string, owner: StoreScope): Effect.Effect<AttestStore, StoreError> => {
  const resolvedPath = resolve(path);
  const lock = migrationLocks.get(resolvedPath) ?? Semaphore.makeUnsafe(1);
  migrationLocks.set(resolvedPath, lock);

  return owner.open(
    resolvedPath,
    'write',
    lock.withPermit(acquireStore(resolvedPath, owner, 'write')),
  );
};

/** Opens only an existing readable schema, without migration or creating fallback. */
const openReadonlyRunStore = (
  path: string,
  owner: StoreScope,
): Effect.Effect<RunStore, StoreError> =>
  Effect.map(
    owner.open(resolve(path), 'readonly', acquireStore(resolve(path), owner, 'readonly')),
    (store) => store.runs,
  );

export { createRunIdentity, openReadonlyRunStore, openStore, type RunStore };
