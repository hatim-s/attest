import type { CasesTable, MetricResultsTable } from '../schema.js';
import type { RunSummary } from '../types.js';
import { parseJson } from './row-mapping.js';

type SummaryCase = Pick<CasesTable, 'id' | 'outcome' | 'expected_metrics_json'>;
type SummaryMetric = Pick<MetricResultsTable, 'case_row_id' | 'metric_name' | 'status' | 'pass'>;
type CaseVerdict = 'pass' | 'fail' | 'error';

/** Applies the PLAN 1S.3 expected-metric verdict rule without penalizing optional extra rows. */
const computeCaseVerdict = (caseRow: SummaryCase, metrics: SummaryMetric[]): CaseVerdict => {
  if (caseRow.outcome !== 'completed') {
    return 'error';
  }

  const expectedMetrics = parseJson<string[]>(caseRow.expected_metrics_json) ?? [];
  const metricsByName = new Map(metrics.map((metric) => [metric.metric_name, metric]));
  let failed = false;
  for (const metricName of expectedMetrics) {
    const metric = metricsByName.get(metricName);
    if (!metric || metric.status !== 'evaluated' || metric.pass === null) {
      return 'error';
    }
    failed ||= metric.pass !== 1;
  }
  return failed ? 'fail' : 'pass';
};

/** Computes exclusive run totals from expected metric names and all persisted metric error rows. */
const computeSummary = (cases: SummaryCase[], metrics: SummaryMetric[]): RunSummary => {
  const metricsByCase = new Map<string, SummaryMetric[]>();
  for (const metric of metrics) {
    const caseMetrics = metricsByCase.get(metric.case_row_id) ?? [];
    caseMetrics.push(metric);
    metricsByCase.set(metric.case_row_id, caseMetrics);
  }

  const verdicts = cases.map((caseRow) =>
    computeCaseVerdict(caseRow, metricsByCase.get(caseRow.id) ?? []),
  );
  return {
    totalCases: cases.length,
    passedCases: verdicts.filter((verdict) => verdict === 'pass').length,
    failedCases: verdicts.filter((verdict) => verdict === 'fail').length,
    errorCases: verdicts.filter((verdict) => verdict === 'error').length,
    metricErrorCount: metrics.filter((metric) => metric.status === 'error').length,
  };
};

export { computeCaseVerdict, computeSummary, type CaseVerdict };
