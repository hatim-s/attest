import { sql, type Kysely } from 'kysely';
import { EVAL_RUN_SCHEMA_ID } from '@attest/contracts';
import { z } from 'zod';
import { canonicalTime } from './dashboard-boundary.js';
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
import type { CasesTable, Database, SuiteTotalsTable, RunsTable } from '../schema.js';

/** Bounded dashboard queries; no method counts history to produce pagination metadata. */
class DashboardReads {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  /** Bounded overview counts are lower bounds when the corresponding truncation flag is set. */
  async getProjectOverview(): Promise<ProjectRunOverview> {
    const evals = await this.listEvals({ limit: 500 });

    const running = await this.#db
      .selectFrom('runs')
      .select('id')
      .where('status', '=', 'running')
      .where('schema_id', '=', EVAL_RUN_SCHEMA_ID)
      .limit(10001)
      .execute();

    const latest = await this.#db
      .selectFrom('run_suite_totals')
      .select('run_created_at')
      .where('is_eval', '=', 1)
      .orderBy('run_created_at', 'desc')
      .orderBy('run_id', 'desc')
      .limit(1)
      .executeTakeFirst();

    return {
      evals,
      runningRunCount: Math.min(running.length, 10000),
      runningRunCountTruncated: running.length > 10000,
      lastRunAt: latest?.run_created_at ?? null,
    };
  }

  /** One JSON parameter keeps local batches within D1's separate 100-parameter budget too. */
  private async slices(rows: SuiteTotalsTable[]): Promise<EvalSlice[]> {
    if (rows.length === 0) return [];
    const ids = JSON.stringify([...new Set(rows.map((row) => row.run_id))]);

    const runs = await this.#db
      .selectFrom('runs')
      .select(['id', 'finished_at', 'status', 'git_branch', 'git_sha'])
      .where(sql<boolean>`id IN (SELECT value FROM json_each(${ids}))`)
      .execute();

    const byId = new Map(runs.map((run) => [run.id, run]));

    return rows.map((row) => this.slice(row, byId.get(row.run_id)!));
  }

  /** Validates persisted totals at hydration, without fetching evidence. */
  private slice(
    row: SuiteTotalsTable,
    run: Pick<RunsTable, 'id' | 'finished_at' | 'status' | 'git_branch' | 'git_sha'>,
  ): EvalSlice {
    try {
      return toEvalSlice(
        parseWithSchemaSync(sliceTotalsSchema, row),
        {
          id: run.id,
          createdAt: row.run_created_at,
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

  /** Catalog paging plus three indexed seeks per key in one statement, independent of history. */
  async listEvals(query: PageQuery = {}): Promise<EvalPage> {
    const limit = parsePageLimit(query);

    if (query.cursor !== undefined) {
      const anchor = await this.#db
        .selectFrom('eval_suites')
        .select('suite_name')
        .where('suite_name', '=', query.cursor)
        .executeTakeFirst();

      if (!anchor) throw new StoreError('INVALID_CURSOR', 'Unknown eval cursor.');
    }

    const rows = await this.#db
      .selectFrom(
        sql<SuiteTotalsTable & { role: string }>`(
      WITH keys AS (SELECT suite_name FROM eval_suites WHERE suite_name > ${query.cursor ?? ''}
        ORDER BY suite_name LIMIT ${limit + 1}),
      roles(role) AS (VALUES ('latest'), ('complete'), ('incomplete'))
      SELECT t.*, roles.role FROM keys CROSS JOIN roles JOIN run_suite_totals t
      ON t.suite_name = keys.suite_name AND t.run_id = CASE roles.role
      WHEN 'latest' THEN (SELECT run_id FROM run_suite_totals WHERE suite_name = keys.suite_name AND is_eval=1 ORDER BY run_created_at DESC,run_id DESC LIMIT 1)
      ELSE (SELECT run_id FROM run_suite_totals WHERE suite_name = keys.suite_name AND is_eval=1 AND state=roles.role ORDER BY run_created_at DESC,run_id DESC LIMIT 1) END
      ORDER BY keys.suite_name,roles.role
    )`.as('page'),
      )
      .selectAll()
      .execute();

    const slices = await this.slices(rows);
    const grouped = new Map<string, Map<string, EvalSlice>>();
    rows.forEach((row, i) => {
      const roles = grouped.get(row.suite_name) ?? new Map<string, EvalSlice>();
      roles.set(row.role, slices[i]!);
      grouped.set(row.suite_name, roles);
    });

    const items = [...grouped.values()]
      .slice(0, limit)
      .map((roles) =>
        summarizeEvalSlices(
          roles.get('latest')!,
          roles.get('complete') ?? null,
          roles.get('incomplete') ?? null,
        ),
      );

    return grouped.size > limit ? { items, nextCursor: items.at(-1)?.suiteName } : { items };
  }

  /** Reads one keyset page, optionally restricted to a trend interval. No exact total is scanned. */
  async listEvalRuns(
    suiteName: string,
    query: PageQuery & { since?: string; until?: string } = {},
  ): Promise<EvalRunPage> {
    const limit = parsePageLimit(query);

    let select = this.#db
      .selectFrom('run_suite_totals')
      .selectAll()
      .where('suite_name', '=', suiteName)
      .where('is_eval', '=', 1)
      .orderBy('run_created_at', 'desc')
      .orderBy('run_id', 'desc')
      .limit(limit + 1);

    const since =
      query.since === undefined ? undefined : canonicalTime(query.since, 'INVALID_LIMIT');

    const until =
      query.until === undefined ? undefined : canonicalTime(query.until, 'INVALID_LIMIT');

    if (since !== undefined && until !== undefined && since >= until)
      throw new StoreError('INVALID_LIMIT', 'Expected since before until.');

    if (since !== undefined) select = select.where('run_created_at', '>=', since);

    if (query.cursor !== undefined) {
      const anchor = await this.#db
        .selectFrom('run_suite_totals')
        .select('run_created_at')
        .where('suite_name', '=', suiteName)
        .where('run_id', '=', query.cursor)
        .where('is_eval', '=', 1)
        .executeTakeFirst();

      if (!anchor) throw new StoreError('INVALID_CURSOR', 'Unknown eval run cursor.');

      if (until !== undefined && anchor.run_created_at >= until)
        throw new StoreError('INVALID_CURSOR', 'Cursor outside interval.');
      select = select.where(
        sql<boolean>`(run_created_at, run_id) < (${anchor.run_created_at}, ${query.cursor})`,
      );
    }

    if (query.cursor === undefined && until !== undefined)
      select = select.where('run_created_at', '<', until);
    const rows = await select.execute();
    const items = await this.slices(rows.slice(0, limit));

    return rows.length > limit ? { items, nextCursor: items.at(-1)?.runId } : { items };
  }

  /** Pages identities before reading at most ten indexed outcome cells per case. */
  async getEvalCaseWindow(suiteName: string, query: PageQuery = {}): Promise<EvalCaseWindow> {
    const limit = parsePageLimit(query);

    let after = '';
    let runs: EvalSlice[];

    if (query.cursor !== undefined) {
      try {
        if (query.cursor.length > 8192) throw new Error('Cursor too large');

        const token = parseWithSchemaSync(
          z.object({ suite: z.string(), after: z.string(), runs: z.array(z.string()).max(10) }),
          JSON.parse(Buffer.from(query.cursor, 'base64url').toString()),
        );

        if (token.suite !== suiteName) throw new Error('Foreign suite');
        after = token.after;

        const rows = await this.#db
          .selectFrom('run_suite_totals')
          .selectAll()
          .where('suite_name', '=', suiteName)
          .where('is_eval', '=', 1)
          .where(
            sql<boolean>`run_id IN (SELECT value FROM json_each(${JSON.stringify(token.runs)}))`,
          )
          .execute();

        const byId = new Map((await this.slices(rows)).map((row) => [row.runId, row]));

        if (byId.size !== token.runs.length) throw new Error('Unknown run');
        runs = token.runs.map((id) => byId.get(id)!);

        const anchor = await this.#db
          .selectFrom('suite_cases')
          .select('case_id')
          .where('suite_name', '=', suiteName)
          .where('case_id', '=', after)
          .executeTakeFirst();

        if (!anchor) throw new Error('Unknown case');
      } catch (cause) {
        throw new StoreError('INVALID_CURSOR', 'Invalid case window cursor.', { cause });
      }
    } else runs = (await this.listEvalRuns(suiteName, { limit: 10 })).items;

    const rows = await this.#db
      .selectFrom('suite_cases')
      .select('case_id')
      .where('suite_name', '=', suiteName)
      .where('case_id', '>', after)
      .orderBy('case_id')
      .limit(limit + 1)
      .execute();

    const page = rows.slice(0, limit);

    const outcomes =
      runs.length === 0 || page.length === 0
        ? []
        : await this.#db
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
              sql<string>`(SELECT value FROM json_each(${JSON.stringify(page.map((row) => row.case_id))}))`,
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
      ? {
          runs,
          items,
          nextCursor: Buffer.from(
            JSON.stringify({
              suite: suiteName,
              after: items.at(-1)?.caseId,
              runs: runs.map((run) => run.runId),
            }),
          ).toString('base64url'),
        }
      : { runs, items };
  }

  /** Uses the covering case-history index, with stable run identity ties. */
  async getCaseHistory(
    suiteName: string,
    caseId: string,
    query: PageQuery = {},
  ): Promise<CaseHistoryPage> {
    const limit = parsePageLimit(query);

    let select = this.#db
      .selectFrom('cases')
      .innerJoin('runs', 'runs.id', 'cases.run_id')
      .select(['run_id', 'run_created_at', 'verdict', 'outcome', 'duration_ms', 'runs.status'])
      .where('cases.is_eval', '=', 1)
      .where('suite_name', '=', suiteName)
      .where('case_id', '=', caseId)
      .orderBy('run_created_at', 'desc')
      .orderBy('run_id', 'desc')
      .limit(limit + 1);

    if (query.cursor !== undefined) {
      const anchor = await this.#db
        .selectFrom('cases')
        .select('run_created_at')
        .where('run_id', '=', query.cursor)
        .where('suite_name', '=', suiteName)
        .where('case_id', '=', caseId)
        .where('is_eval', '=', 1)
        .executeTakeFirst();

      if (!anchor) throw new StoreError('INVALID_CURSOR', 'Unknown case history cursor.');
      select = select.where(
        sql<boolean>`(run_created_at, run_id) < (${anchor.run_created_at}, ${query.cursor})`,
      );
    }

    const rows = await select.execute();
    const items: CaseHistoryPage['items'] = [];

    for (const row of rows.slice(0, limit)) {
      items.push({
        runId: row.run_id,
        createdAt: row.run_created_at,
        runStatus: row.status,
        cell: row.outcome === 'cancelled' ? 'skipped' : row.verdict,
        durationMs: row.duration_ms,
      });
    }

    return rows.length > limit ? { items, nextCursor: items.at(-1)?.runId } : { items };
  }

  /** UTC buckets over at most 10,000 recent slices. Dense intervals report truncation explicitly. */
  async getActivity(query: { from: string; to: string }): Promise<Activity> {
    const from = Date.parse(canonicalTime(query.from, 'INVALID_LIMIT'));
    const to = Date.parse(canonicalTime(query.to, 'INVALID_LIMIT'));

    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 92 * 86400000)
      throw new StoreError('INVALID_LIMIT', 'Activity requires an interval of at most 92 days.');

    const rows = await this.#db
      .selectFrom('run_suite_totals')
      .selectAll()
      .where('is_eval', '=', 1)
      .where('run_created_at', '>=', new Date(from).toISOString())
      .where('run_created_at', '<', new Date(to).toISOString())
      .orderBy('run_created_at', 'desc')
      .orderBy('run_id', 'desc')
      .orderBy('suite_name')
      .limit(10001)
      .execute();

    const days = new Map<string, Activity['days'][number]>();

    const truncated = rows.length > 10000;

    // Drop the entire boundary UTC day, including ties. No partial total looks exact.
    const cutoff = truncated
      ? new Date(
          Date.parse(rows[10000]!.run_created_at.slice(0, 10) + 'T00:00:00.000Z') + 86400000,
        ).toISOString()
      : new Date(from).toISOString();

    for (const row of rows.slice(0, 10000).filter((row) => row.run_created_at >= cutoff)) {
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
      coveredFrom: cutoff > new Date(to).toISOString() ? new Date(to).toISOString() : cutoff,
      coveredTo: new Date(to).toISOString(),
      timezone: 'UTC',
      days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
      truncated: rows.length > 10000,
    };
  }

  /** Reads just the eval slices belonging to one run. */
  async listRunSuites(runId: string): Promise<EvalSlice[]> {
    const run = await this.#db
      .selectFrom('runs')
      .selectAll()
      .where('id', '=', runId)
      .executeTakeFirst();

    if (!run) throw new StoreError('RUN_NOT_FOUND', 'Run was not found.');

    const rows = await this.#db
      .selectFrom('run_suite_totals')
      .selectAll()
      .where('run_id', '=', runId)
      .orderBy('suite_name')
      .execute();

    return rows.map((row) => this.slice(row, run));
  }
}

export { DashboardReads };
