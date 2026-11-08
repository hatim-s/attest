import { summarizeCaseRecord, StoreError } from '@attest/core';
import { Kysely } from 'kysely';
import { canonicalTime } from '@attest/core/records';
import { historicalPlan } from './dashboard-boundary.js';
import { EVAL_RUN_SCHEMA_ID } from '@attest/contracts';
import type { Database } from '../schema.js';
import type { SqliteHandle } from './sqlite-handle.js';
import { createSqliteDialect } from './kysely-sqlite-dialect.js';
import { toRunRecord, toCaseRecord, toMetricEvaluation } from './row-mapping.js';
import { seedSuiteTotals, incrementSuiteTotals, finalizeSuiteTotals } from './dashboard-totals.js';

/** Offline v1 rebuild inside the migration's single write transaction; no partial version is published. */
const backfillDashboardTotals = async (handle: SqliteHandle): Promise<void> => {
  const db = new Kysely<Database>({ dialect: createSqliteDialect(handle) });
  let cursor = '';

  for (;;) {
    const runs = await db
      .selectFrom('runs')
      .selectAll()
      .where('id', '>', cursor)
      .orderBy('id')
      .limit(100)
      .execute();

    if (runs.length === 0) break;

    for (const row of runs) {
      const run = toRunRecord(row, undefined);

      const plan =
        run.schemaId === EVAL_RUN_SCHEMA_ID ? historicalPlan(run.configJson, run.id) : null;

      await db
        .updateTable('runs')
        .set({
          created_order: canonicalTime(run.createdAt, 'CORRUPT_DATA'),
        })
        .where('id', '=', run.id)
        .execute();

      await seedSuiteTotals(db, run, plan);
      const cases = await db.selectFrom('cases').selectAll().where('run_id', '=', run.id).execute();

      for (const caseRow of cases) {
        const metrics = await db
          .selectFrom('metric_results')
          .selectAll()
          .where('case_row_id', '=', caseRow.id)
          .execute();

        const summary = summarizeCaseRecord(toCaseRecord(caseRow, metrics.map(toMetricEvaluation)));
        await db
          .updateTable('cases')
          .set({
            verdict: summary.verdict,
            is_eval: Number(run.schemaId === EVAL_RUN_SCHEMA_ID),
            run_created_at: canonicalTime(run.createdAt, 'CORRUPT_DATA'),
          })
          .where('id', '=', caseRow.id)
          .execute();
        await incrementSuiteTotals(db, run.id, run.createdAt, summary, 'CORRUPT_DATA');
      }

      await finalizeSuiteTotals(db, run);
    }

    cursor = runs.at(-1)?.id ?? cursor;
  }

  const missing = await handle
    .prepare('SELECT id FROM cases WHERE verdict IS NULL OR run_created_at IS NULL LIMIT 1')
    .all();

  if (missing.length > 0)
    throw new StoreError('CORRUPT_DATA', 'Backfill left cases without projections.');
};

export { backfillDashboardTotals };
