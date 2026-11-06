import { EVAL_RUN_SCHEMA_ID } from '@attest/contracts';
import { canonicalTime, historicalPlan } from './dashboard-boundary.js';
import { sql, type Kysely } from 'kysely';
import {
  emptyRunSummary,
  addSliceToRunSummary,
  addCaseToTotals,
  emptySliceTotals,
  toEvalSlice,
} from '@attest/core/analytics';
import {
  plannedSuiteCases,
  StoreError,
  type RunRecord,
  type CaseSummary,
  type RunSummary,
} from '@attest/core';
import type { Database } from '../schema.js';

/** Seeds participating evals; empty selections do not create slices. */
const seedSuiteTotals = async (
  db: Kysely<Database>,
  run: RunRecord,
  plan = plannedSuiteCases(run.schemaId, run.configJson),
): Promise<void> => {
  for (const [suiteName, planned] of plan ?? []) {
    if (planned === 0) continue;
    await db
      .insertInto('eval_suites')
      .values({ suite_name: suiteName })
      .onConflict((oc) => oc.doNothing())
      .execute();
    await db
      .insertInto('run_suite_totals')
      .values({
        run_id: run.id,
        suite_name: suiteName,
        run_created_at: canonicalTime(run.createdAt, 'CORRUPT_DATA'),
        is_eval: Number(run.schemaId === EVAL_RUN_SCHEMA_ID),
        state: 'running',
        ...emptySliceTotals(planned),
      })
      .execute();
  }
};

/** Updates only on actual insert, in the caller's case transaction. */
const incrementSuiteTotals = async (
  db: Kysely<Database>,
  runId: string,
  createdAt: string,
  summary: CaseSummary,
): Promise<void> => {
  const run = await db
    .selectFrom('runs')
    .select(['schema_id', 'config_json'])
    .where('id', '=', runId)
    .executeTakeFirstOrThrow();

  const previous = await db
    .selectFrom('run_suite_totals')
    .select(['planned', 'recorded'])
    .where('run_id', '=', runId)
    .where('suite_name', '=', summary.suiteName)
    .executeTakeFirst();

  // Empty selected suites have no totals row, but their known zero still forbids evidence.
  const planned =
    previous === undefined && run.schema_id === EVAL_RUN_SCHEMA_ID
      ? historicalPlan(run.config_json, runId)?.get(summary.suiteName)
      : previous?.planned;

  if (planned !== null && planned !== undefined && (previous?.recorded ?? 0) >= planned)
    throw new StoreError(
      'CORRUPT_DATA',
      `Recorded cases exceed plan in run ${runId}, suite ${summary.suiteName}.`,
    );

  if (run.schema_id === EVAL_RUN_SCHEMA_ID)
    await db
      .insertInto('eval_suites')
      .values({ suite_name: summary.suiteName })
      .onConflict((oc) => oc.doNothing())
      .execute();

  if (run.schema_id === EVAL_RUN_SCHEMA_ID)
    await db
      .insertInto('suite_cases')
      .values({ suite_name: summary.suiteName, case_id: summary.caseId })
      .onConflict((oc) => oc.doNothing())
      .execute();
  const delta = addCaseToTotals(emptySliceTotals(null), summary);
  await db
    .insertInto('run_suite_totals')
    .values({
      run_id: runId,
      suite_name: summary.suiteName,
      run_created_at: canonicalTime(createdAt, 'CORRUPT_DATA'),
      is_eval: Number(run.schema_id === EVAL_RUN_SCHEMA_ID),
      state: 'running',
      ...delta,
    })
    .onConflict((oc) =>
      oc.columns(['run_id', 'suite_name']).doUpdateSet({
        recorded: sql`recorded + ${delta.recorded}`,
        passed: sql`passed + ${delta.passed}`,
        failed: sql`failed + ${delta.failed}`,
        errored: sql`errored + ${delta.errored}`,
        skipped: sql`skipped + ${delta.skipped}`,
        metricErrors: sql`metricErrors + ${delta.metricErrors}`,
        scored: sql`scored + ${delta.scored}`,
        scoreSum: sql`scoreSum + ${delta.scoreSum}`,
      }),
    )
    .execute();
};

/** Freezes indexed completeness before the parent run becomes immutable. */
const finalizeSuiteTotals = async (db: Kysely<Database>, run: RunRecord): Promise<void> => {
  const rows = await db
    .selectFrom('run_suite_totals')
    .selectAll()
    .where('run_id', '=', run.id)
    .execute();

  for (const row of rows) {
    const slice = toEvalSlice(row, run, row.suite_name);
    await db
      .updateTable('run_suite_totals')
      .set({ state: slice.state })
      .where('run_id', '=', run.id)
      .where('suite_name', '=', row.suite_name)
      .execute();
  }
};

/** Sums tiny per-eval records, never case or metric evidence. */
const summarizeRuns = async (
  db: Kysely<Database>,
  ids: readonly string[],
): Promise<(id: string) => RunSummary> => {
  const rows =
    ids.length === 0
      ? []
      : await db.selectFrom('run_suite_totals').selectAll().where('run_id', 'in', ids).execute();

  const sums = new Map<string, RunSummary>();

  for (const row of rows) {
    sums.set(row.run_id, addSliceToRunSummary(sums.get(row.run_id) ?? emptyRunSummary(), row));
  }

  return (id) => sums.get(id) ?? emptyRunSummary();
};

export { seedSuiteTotals, incrementSuiteTotals, finalizeSuiteTotals, summarizeRuns };
