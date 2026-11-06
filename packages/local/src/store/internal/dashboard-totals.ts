import { sql, type Kysely } from 'kysely';
import { addCaseToTotals, emptySliceTotals, toEvalSlice } from '@attest/core/analytics';
import {
  plannedSuiteCases,
  summarizeCaseRecord,
  type RunRecord,
  type CaseSummary,
  type RunSummary,
} from '@attest/core';
import type { Database } from '../schema.js';

/** Seeds zero rows so selected evals without a recorded case remain visible. */
const seedSuiteTotals = async (db: Kysely<Database>, run: RunRecord): Promise<void> => {
  for (const [suiteName, planned] of plannedSuiteCases(run.schemaId, run.configJson) ?? []) {
    await db
      .insertInto('run_suite_totals')
      .values({
        run_id: run.id,
        suite_name: suiteName,
        run_created_at: run.createdAt,
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
      run_created_at: createdAt,
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
    const sum = sums.get(row.run_id) ?? {
      totalCases: 0,
      passedCases: 0,
      failedCases: 0,
      errorCases: 0,
      metricErrorCount: 0,
    };

    sum.totalCases += row.recorded;
    sum.passedCases += row.passed;
    sum.failedCases += row.failed;
    sum.errorCases += row.errored + row.skipped;
    sum.metricErrorCount += row.metricErrors;
    sums.set(row.run_id, sum);
  }

  return (id) =>
    sums.get(id) ?? {
      totalCases: 0,
      passedCases: 0,
      failedCases: 0,
      errorCases: 0,
      metricErrorCount: 0,
    };
};

export {
  seedSuiteTotals,
  incrementSuiteTotals,
  finalizeSuiteTotals,
  summarizeRuns,
  summarizeCaseRecord,
};
