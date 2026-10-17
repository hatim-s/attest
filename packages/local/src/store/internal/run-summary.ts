import { sql } from 'kysely';
import { z } from 'zod';

import type { CasesTable, MetricResultsTable } from '../schema.js';
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

/** Computes exclusive run totals from case rows and every persisted metric row. */
const computeSummary = (cases: SummaryCase[], metrics: SummaryMetric[]): RunSummary => {
  const metricsByCase = new Map<string, SummaryMetric[]>();

  for (const metric of metrics) {
    const caseMetrics = metricsByCase.get(metric.case_row_id) ?? [];
    caseMetrics.push(metric);
    metricsByCase.set(metric.case_row_id, caseMetrics);
  }

  return summarizeVerdicts(
    cases.map((caseRow) => {
      const caseMetrics = metricsByCase.get(caseRow.id) ?? [];

      return { verdict: rowVerdict(caseRow, caseMetrics), metrics: caseMetrics };
    }),
  );
};

export { agentErroredColumn, computeSummary, lifecycleFailedColumn, rowVerdict };
