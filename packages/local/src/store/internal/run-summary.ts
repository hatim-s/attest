import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { CasesTable, Database, MetricResultsTable } from '../schema.js';
import {
  computeCaseVerdict,
  summarizeVerdicts,
  type CaseVerdict,
  type MetricVerdictEvidence,
  type RunSummary,
} from '@attest/core';
import { parseJson } from './row-mapping.js';

/**
 * Verdict flags read inside SQLite, so summaries and case pages never load response or diagnostics
 * blobs. Each is 1 when the stored JSON carries the field.
 */
const lifecycleFailedColumn =
  sql<number>`json_extract(diagnostics_json, '$.lifecycleError') is not null`.as(
    'lifecycle_failed',
  );

const agentErroredColumn = sql<number>`json_extract(response_json, '$.error') is not null`.as(
  'agent_errored',
);

type SummaryCase = Pick<CasesTable, 'id' | 'outcome' | 'expected_metrics_json'> & {
  lifecycle_failed: number;
  agent_errored: number;
};

type SummaryMetric = Pick<MetricResultsTable, 'case_row_id' | 'metric_name' | 'status' | 'pass'>;

// An evaluated row without a pass value cannot count as evaluated evidence.
const toVerdictMetric = (metric: SummaryMetric): MetricVerdictEvidence =>
  metric.status === 'evaluated' && metric.pass !== null
    ? { metricName: metric.metric_name, status: 'evaluated', pass: metric.pass === 1 }
    : { metricName: metric.metric_name, status: 'error' };

/** Applies core's verdict rule to one case row and its metric rows. */
const rowVerdict = (caseRow: SummaryCase, metrics: readonly SummaryMetric[]): CaseVerdict =>
  computeCaseVerdict(
    {
      outcome: caseRow.outcome,
      expectedMetrics: z.array(z.string()).parse(parseJson(caseRow.expected_metrics_json) ?? []),
      lifecycleFailed: caseRow.lifecycle_failed === 1,
      agentErrored: caseRow.agent_errored === 1,
    },
    metrics.map(toVerdictMetric),
  );

const groupBy = <T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> => {
  const grouped = new Map<string, T[]>();

  for (const row of rows) {
    const group = grouped.get(key(row));

    if (group) group.push(row);
    else grouped.set(key(row), [row]);
  }

  return grouped;
};

/**
 * Computes each run's exclusive totals from its case and metric rows. Reads call this instead of
 * trusting summary_json, because runs finalized before the shared verdict rule stored totals that
 * disagree with their own case list. Persisted rows stay untouched.
 */
const summarizeRuns = async (
  database: Kysely<Database>,
  runIds: readonly string[],
): Promise<(runId: string) => RunSummary> => {
  if (runIds.length === 0) return () => summarizeVerdicts([]);

  const cases = await database
    .selectFrom('cases')
    .select([
      'id',
      'run_id',
      'outcome',
      'expected_metrics_json',
      lifecycleFailedColumn,
      agentErroredColumn,
    ])
    .where('run_id', 'in', runIds)
    .execute();

  const metrics = await database
    .selectFrom('metric_results')
    .innerJoin('cases', 'cases.id', 'metric_results.case_row_id')
    .select([
      'metric_results.case_row_id',
      'metric_results.metric_name',
      'metric_results.status',
      'metric_results.pass',
    ])
    .where('cases.run_id', 'in', runIds)
    .execute();

  const metricsByCase = groupBy(metrics, (metric) => metric.case_row_id);
  const casesByRun = groupBy(cases, (caseRow) => caseRow.run_id);

  return (runId) =>
    summarizeVerdicts(
      (casesByRun.get(runId) ?? []).map((caseRow) => {
        const caseMetrics = metricsByCase.get(caseRow.id) ?? [];

        return { verdict: rowVerdict(caseRow, caseMetrics), metrics: caseMetrics };
      }),
    );
};

export { agentErroredColumn, lifecycleFailedColumn, rowVerdict, summarizeRuns };
