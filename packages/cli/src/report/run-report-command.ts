import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  openStore,
  type CaseRecord,
  type CaseSummary,
  type StoredMetricEvaluation,
} from '@attest/core';
import { dashboardHtml } from '@attest/web/embedded';

import { AttestCliError } from '../errors.js';
import { createReportHtml } from './create-report-html.js';

const MAX_REPORT_CASES = 10_000;

type RunReportCommandOptions = {
  force?: boolean;
  outputPath?: string;
  runId: string;
  storePath?: string;
  workingDirectory: string;
};

type RunReportCommandResult = {
  caseCount: number;
  outputPath: string;
  totalCaseCount: number;
  truncated: boolean;
};

const metricCounts = (
  expectedMetrics: string[],
  metrics: StoredMetricEvaluation[],
): CaseSummary['metricCounts'] => ({
  expected: expectedMetrics.length,
  evaluated: metrics.filter(({ status }) => status === 'evaluated').length,
  passed: metrics.filter(({ pass, status }) => status === 'evaluated' && pass === true).length,
  errors: metrics.filter(({ status }) => status === 'error').length,
});

/** Averages evaluated metric scores for the report's case-list projection. */
const averageMetricScore = (metrics: StoredMetricEvaluation[]): number | undefined => {
  const scores = metrics.flatMap((metric) =>
    metric.status === 'evaluated' && metric.score !== undefined ? [metric.score] : [],
  );
  return scores.length === 0
    ? undefined
    : scores.reduce((total, score) => total + score, 0) / scores.length;
};

/** Applies the store's expected-metric verdict rule to a restored case record. */
const caseVerdict = (record: CaseRecord): CaseSummary['verdict'] => {
  if (record.outcome !== 'completed') return 'error';
  const metrics = new Map(record.metrics.map((metric) => [metric.metricName, metric]));
  let failed = false;
  for (const metricName of record.expectedMetrics) {
    const metric = metrics.get(metricName);
    if (metric?.status !== 'evaluated' || metric.pass === undefined) return 'error';
    failed ||= metric.pass === false;
  }
  return failed ? 'fail' : 'pass';
};

/** Projects the full stored case into the same lightweight row shape used by the live API. */
const toCaseSummary = (record: CaseRecord): CaseSummary => {
  const score = averageMetricScore(record.metrics);
  return {
    caseId: record.caseId,
    suiteName: record.suiteName,
    outcome: record.outcome,
    verdict: caseVerdict(record),
    startedAt: record.startedAt,
    durationMs: record.durationMs,
    ...(score === undefined ? {} : { score }),
    metricCounts: metricCounts(record.expectedMetrics, record.metrics),
  };
};

/** Applies the report evidence ceiling without mutating the store result. */
const selectReportCases = <T>(cases: T[]): { cases: T[]; truncated: boolean } => ({
  cases: cases.slice(0, MAX_REPORT_CASES),
  truncated: cases.length > MAX_REPORT_CASES,
});

const isNodeError = (error: unknown): error is NodeJS.ErrnoException => error instanceof Error;

/** Materializes one bounded, self-contained run report without overwriting by default. */
const runReportCommand = async (
  options: RunReportCommandOptions,
): Promise<RunReportCommandResult> => {
  const storePath = resolve(options.workingDirectory, options.storePath ?? '.attest/runs.db');
  const store = await openStore(storePath);
  let runWithCases: Awaited<ReturnType<typeof store.runs.getRunWithCases>>;
  try {
    runWithCases = await store.runs.getRunWithCases(options.runId);
  } finally {
    await store.close();
  }

  const selection = selectReportCases(runWithCases.cases);
  const reportData = {
    api_version: 'attest.report/v1',
    generatedAt: new Date().toISOString(),
    run: runWithCases.run,
    cases: selection.cases.map((record) => ({ record, summary: toCaseSummary(record) })),
    truncated: selection.truncated,
  };
  const outputPath = resolve(
    options.workingDirectory,
    options.outputPath ?? `attest-report-${options.runId}.html`,
  );

  try {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, createReportHtml(dashboardHtml, reportData), {
      encoding: 'utf8',
      flag: options.force === true ? 'w' : 'wx',
    });
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new AttestCliError(
        'output_exists',
        `Report already exists at ${outputPath}; pass --force to replace it.`,
        { cause: error },
      );
    }
    throw new AttestCliError('output_write_failed', `Could not write report to ${outputPath}.`, {
      cause: error,
    });
  }

  return {
    caseCount: selection.cases.length,
    outputPath,
    totalCaseCount: runWithCases.cases.length,
    truncated: selection.truncated,
  };
};

export {
  MAX_REPORT_CASES,
  caseVerdict,
  runReportCommand,
  selectReportCases,
  toCaseSummary,
  type RunReportCommandOptions,
  type RunReportCommandResult,
};
