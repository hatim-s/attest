import { sql, type Kysely } from 'kysely';
import { parseWithSchemaSync } from '@attest/contracts';
import { summarizeEvalSlices, toEvalSlice } from '@attest/core/analytics';
import {
  StoreError,
  parsePageLimit,
  sliceTotalsSchema,
  type PageQuery,
  type EvalSlice,
  type EvalPage,
  type ProjectRunOverview,
  type EvalRunPage,
  type EvalCaseWindow,
  type CaseHistoryPage,
  type Activity,
} from '@attest/core';
import type { CasesTable, Database, SuiteTotalsTable } from '../schema.js';

/** Bounded dashboard queries; no method counts history to produce pagination metadata. */
class DashboardReads {
  readonly db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.db = db;
  }

  /** Bounded overview counts are lower bounds when the corresponding truncation flag is set. */
  async getProjectOverview(): Promise<ProjectRunOverview> {
    const evals = await this.listEvals({ limit: 500 });

    const running = await this.db
      .selectFrom('runs')
      .select('id')
      .where('status', '=', 'running')
      .limit(10001)
      .execute();

    const latest = await this.db
      .selectFrom('runs')
      .select('created_at')
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();

    return {
      evals,
      runningRunCount: Math.min(running.length, 10000),
      runningRunCountTruncated: running.length > 10000,
      lastRunAt: latest?.created_at ?? null,
    };
  }

  /** Hydrates metadata only after the indexed totals query has bounded its rows. */
  async slice(row: SuiteTotalsTable): Promise<EvalSlice> {
    const run = await this.db
      .selectFrom('runs')
      .select(['id', 'created_at', 'finished_at', 'status', 'git_branch', 'git_sha'])
      .where('id', '=', row.run_id)
      .executeTakeFirstOrThrow();

    try {
      return toEvalSlice(
        parseWithSchemaSync(sliceTotalsSchema, row),
        {
          id: run.id,
          createdAt: run.created_at,
          finishedAt: run.finished_at ?? undefined,
          status: run.status,
          gitBranch: run.git_branch ?? undefined,
          gitSha: run.git_sha ?? undefined,
        },
        row.suite_name,
      );
    } catch (cause) {
      throw new StoreError('CORRUPT_DATA', 'Invalid stored dashboard totals.', { cause });
    }
  }

  /** Uses a distinct-key seek per eval and a state index for arbitrarily long incomplete tails. */
  async listEvals(query: PageQuery = {}): Promise<EvalPage> {
    const limit = parsePageLimit(query);

    if (query.cursor !== undefined) {
      const anchor = await this.db
        .selectFrom('run_suite_totals')
        .select('suite_name')
        .where('suite_name', '=', query.cursor)
        .limit(1)
        .executeTakeFirst();

      if (!anchor) throw new StoreError('INVALID_CURSOR', 'Unknown eval cursor.');
    }

    let key = query.cursor ?? '';
    const items: EvalPage['items'] = [];

    for (let i = 0; i <= limit; i++) {
      const next = await this.db
        .selectFrom('run_suite_totals')
        .select('suite_name')
        .where('suite_name', '>', key)
        .orderBy('suite_name')
        .limit(1)
        .executeTakeFirst();

      if (!next) break;
      key = next.suite_name;

      if (i === limit) return { items, nextCursor: items.at(-1)?.suiteName };

      const latest = await this.db
        .selectFrom('run_suite_totals')
        .selectAll()
        .where('suite_name', '=', key)
        .orderBy('run_created_at', 'desc')
        .orderBy('run_id', 'desc')
        .limit(1)
        .executeTakeFirstOrThrow();

      const complete = await this.db
        .selectFrom('run_suite_totals')
        .selectAll()
        .where('suite_name', '=', key)
        .where('state', '=', 'complete')
        .orderBy('run_created_at', 'desc')
        .orderBy('run_id', 'desc')
        .limit(1)
        .executeTakeFirst();

      const incomplete = await this.db
        .selectFrom('run_suite_totals')
        .selectAll()
        .where('suite_name', '=', key)
        .where('state', '=', 'incomplete')
        .orderBy('run_created_at', 'desc')
        .orderBy('run_id', 'desc')
        .limit(1)
        .executeTakeFirst();

      items.push(
        summarizeEvalSlices(
          await this.slice(latest),
          complete ? await this.slice(complete) : null,
          incomplete ? await this.slice(incomplete) : null,
        ),
      );
    }

    return { items };
  }

  /** Reads one keyset page, optionally restricted to a trend interval. No exact total is scanned. */
  async listEvalRuns(
    suiteName: string,
    query: PageQuery & { since?: string; until?: string } = {},
  ): Promise<EvalRunPage> {
    const limit = parsePageLimit(query);

    let select = this.db
      .selectFrom('run_suite_totals')
      .selectAll()
      .where('suite_name', '=', suiteName)
      .orderBy('run_created_at', 'desc')
      .orderBy('run_id', 'desc')
      .limit(limit + 1);

    if (query.since !== undefined) select = select.where('run_created_at', '>=', query.since);

    if (query.until !== undefined) select = select.where('run_created_at', '<', query.until);

    if (query.cursor !== undefined) {
      const anchor = await this.db
        .selectFrom('run_suite_totals')
        .select('run_created_at')
        .where('suite_name', '=', suiteName)
        .where('run_id', '=', query.cursor)
        .executeTakeFirst();

      if (!anchor) throw new StoreError('INVALID_CURSOR', 'Unknown eval run cursor.');
      select = select.where(
        sql<boolean>`(run_created_at, run_id) < (${anchor.run_created_at}, ${query.cursor})`,
      );
    }

    const rows = await select.execute();
    const items = await Promise.all(rows.slice(0, limit).map((row) => this.slice(row)));

    return rows.length > limit ? { items, nextCursor: items.at(-1)?.runId } : { items };
  }

  /** Pages identities before reading at most ten indexed outcome cells per case. */
  async getEvalCaseWindow(suiteName: string, query: PageQuery = {}): Promise<EvalCaseWindow> {
    const limit = parsePageLimit(query);

    if (query.cursor !== undefined) {
      const anchor = await this.db
        .selectFrom('suite_cases')
        .select('case_id')
        .where('suite_name', '=', suiteName)
        .where('case_id', '=', query.cursor)
        .executeTakeFirst();

      if (!anchor) throw new StoreError('INVALID_CURSOR', 'Unknown case window cursor.');
    }

    const runs = (await this.listEvalRuns(suiteName, { limit: 10 })).items;

    const rows = await this.db
      .selectFrom('suite_cases')
      .select('case_id')
      .where('suite_name', '=', suiteName)
      .where('case_id', '>', query.cursor ?? '')
      .orderBy('case_id')
      .limit(limit + 1)
      .execute();

    const page = rows.slice(0, limit);

    const outcomes =
      runs.length === 0 || page.length === 0
        ? []
        : await this.db
            // Pin lookups by run/case. The history index can otherwise scan every older outcome.
            .selectFrom(
              sql<CasesTable>`(select * from cases indexed by idx_cases_window)`.as('cases'),
            )
            .select(['run_id', 'case_id', 'verdict', 'outcome'])
            .where('suite_name', '=', suiteName)
            .where(
              'run_id',
              'in',
              runs.map((run) => run.runId),
            )
            .where(
              'case_id',
              'in',
              page.map((row) => row.case_id),
            )
            .execute();

    const cells = new Map(
      outcomes.map((row) => [
        JSON.stringify([row.run_id, row.case_id]),
        row.outcome === 'cancelled' ? ('skipped' as const) : row.verdict,
      ]),
    );

    const items: EvalCaseWindow['items'] = page.map((row) => ({
      caseId: row.case_id,
      cells: runs.map((run) => cells.get(JSON.stringify([run.runId, row.case_id])) ?? null),
    }));

    return rows.length > limit
      ? { runs, items, nextCursor: items.at(-1)?.caseId }
      : { runs, items };
  }

  /** Uses the covering case-history index, with stable run identity ties. */
  async getCaseHistory(
    suiteName: string,
    caseId: string,
    query: PageQuery = {},
  ): Promise<CaseHistoryPage> {
    const limit = parsePageLimit(query);

    let select = this.db
      .selectFrom('cases')
      .select(['run_id', 'run_created_at', 'verdict', 'outcome', 'duration_ms'])
      .where('suite_name', '=', suiteName)
      .where('case_id', '=', caseId)
      .orderBy('run_created_at', 'desc')
      .orderBy('run_id', 'desc')
      .limit(limit + 1);

    if (query.cursor !== undefined) {
      const anchor = await this.db
        .selectFrom('cases')
        .select('run_created_at')
        .where('run_id', '=', query.cursor)
        .where('suite_name', '=', suiteName)
        .where('case_id', '=', caseId)
        .executeTakeFirst();

      if (!anchor) throw new StoreError('INVALID_CURSOR', 'Unknown case history cursor.');
      select = select.where(
        sql<boolean>`(run_created_at, run_id) < (${anchor.run_created_at}, ${query.cursor})`,
      );
    }

    const rows = await select.execute();
    const items: CaseHistoryPage['items'] = [];

    for (const row of rows.slice(0, limit)) {
      const run = await this.db
        .selectFrom('runs')
        .select('status')
        .where('id', '=', row.run_id)
        .executeTakeFirstOrThrow();

      items.push({
        runId: row.run_id,
        createdAt: row.run_created_at,
        runStatus: run.status,
        cell: row.outcome === 'cancelled' ? 'skipped' : row.verdict,
        durationMs: row.duration_ms,
      });
    }

    return rows.length > limit ? { items, nextCursor: items.at(-1)?.runId } : { items };
  }

  /** UTC buckets over at most 10,000 recent slices. Dense intervals report truncation explicitly. */
  async getActivity(query: { from: string; to: string }): Promise<Activity> {
    const from = Date.parse(query.from);
    const to = Date.parse(query.to);

    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 92 * 86400000)
      throw new StoreError('INVALID_LIMIT', 'Activity requires an interval of at most 92 days.');

    const rows = await this.db
      .selectFrom('run_suite_totals')
      .selectAll()
      .where('run_created_at', '>=', new Date(from).toISOString())
      .where('run_created_at', '<', new Date(to).toISOString())
      .orderBy('run_created_at', 'desc')
      .orderBy('run_id', 'desc')
      .orderBy('suite_name')
      .limit(10001)
      .execute();

    const days = new Map<string, Activity['days'][number]>();

    for (const row of rows.slice(0, 10000)) {
      const day = new Date(row.run_created_at).toISOString().slice(0, 10);

      const bucket = days.get(day) ?? {
        day,
        slices: 0,
        passed: 0,
        failed: 0,
        errored: 0,
        skipped: 0,
      };

      bucket.slices++;
      bucket.passed += row.passed;
      bucket.failed += row.failed;
      bucket.errored += row.errored;
      bucket.skipped += row.skipped;
      days.set(day, bucket);
    }

    return {
      timezone: 'UTC',
      days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
      truncated: rows.length > 10000,
    };
  }

  /** Reads just the eval slices belonging to one run. */
  async listRunSuites(runId: string): Promise<EvalSlice[]> {
    const run = await this.db
      .selectFrom('runs')
      .select('id')
      .where('id', '=', runId)
      .executeTakeFirst();

    if (!run) throw new StoreError('RUN_NOT_FOUND', 'Run was not found.');

    const rows = await this.db
      .selectFrom('run_suite_totals')
      .selectAll()
      .where('run_id', '=', runId)
      .orderBy('suite_name')
      .execute();

    return Promise.all(rows.map((row) => this.slice(row)));
  }
}

export { DashboardReads };
