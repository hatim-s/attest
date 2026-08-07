import { afterEach, describe, expect, it, vi } from 'vitest';

import { getCase, getRun, listCases, listRuns } from './client.js';
import type { CaseRecord, CaseSummary, RunRecord } from './types.js';
import type { ReportData } from '../report/report-data.js';

const run: RunRecord = {
  id: 'report-run',
  configHash: 'sha256:test',
  configJson: '{}',
  configVersion: '1',
  createdAt: '2026-08-07T00:00:00.000Z',
  status: 'completed',
};
const summary: CaseSummary = {
  caseId: 'one',
  durationMs: 2,
  metricCounts: { errors: 0, evaluated: 0, expected: 0, passed: 0 },
  outcome: 'completed',
  startedAt: '2026-08-07T00:00:00.000Z',
  suiteName: 'smoke',
  verdict: 'pass',
};
const record: CaseRecord = {
  attempts: [],
  caseId: summary.caseId,
  diagnostics: {},
  durationMs: summary.durationMs,
  expectedMetrics: [],
  inputHash: 'sha256:input',
  metrics: [],
  outcome: 'completed',
  request: {},
  response: {},
  rowId: 'row-one',
  runId: run.id,
  startedAt: summary.startedAt,
  suiteName: summary.suiteName,
  warnings: [],
};
const report: ReportData = {
  api_version: 'attest.report/v1',
  cases: [{ record, summary }],
  generatedAt: '2026-08-07T00:00:01.000Z',
  run,
  truncated: false,
};

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window');
  vi.unstubAllGlobals();
});

describe('static report data client', () => {
  it('serves every report read without touching the network', async () => {
    Object.assign(globalThis, { window: { __ATTEST_REPORT__: report } });
    const fetch = vi.fn(() => Promise.reject(new Error('network must stay unused')));
    vi.stubGlobal('fetch', fetch);

    await expect(listRuns()).resolves.toEqual([run]);
    await expect(getRun(run.id)).resolves.toEqual(run);
    await expect(listCases(run.id)).resolves.toEqual({ items: [summary] });
    await expect(getCase(run.id, summary.suiteName, summary.caseId)).resolves.toEqual(record);
    expect(fetch).not.toHaveBeenCalled();
  });
});
