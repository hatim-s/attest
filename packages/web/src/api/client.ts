import type { CaseRecord, CaseSummary, RunDiff, RunRecord } from './types.js';
import { getReportData } from '../report/report-data.js';

type ApiEnvelope = { schema: 'attest.view' };
type ApiErrorEnvelope = { error?: { code?: string; message?: string } };

/** Reads one JSON response and turns the server error envelope into a useful exception. */
const fetchJson = async <T>(path: string): Promise<T> => {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  const body = (await response.json()) as T & ApiErrorEnvelope;
  if (!response.ok) {
    throw new Error(body.error?.message ?? `Attest API request failed (${response.status}).`);
  }
  return body;
};

/** Encodes user-authored suite and case identifiers as individual URL segments. */
const segment = (value: string): string => encodeURIComponent(value);

const listRuns = async (): Promise<RunRecord[]> => {
  const report = getReportData();
  if (report !== undefined) return [report.run];
  const body = await fetchJson<ApiEnvelope & { runs: RunRecord[] }>('/api/runs?limit=100');
  return body.runs;
};

const getRun = async (runId: string): Promise<RunRecord> => {
  const report = getReportData();
  if (report !== undefined) {
    if (report.run.id === runId) return report.run;
    throw new Error(`Run ${runId} is not included in this static report.`);
  }
  const body = await fetchJson<ApiEnvelope & { run: RunRecord }>(`/api/runs/${segment(runId)}`);
  return body.run;
};

const listCases = async (
  runId: string,
  cursor?: string,
): Promise<{ items: CaseSummary[]; nextCursor?: string }> => {
  const report = getReportData();
  if (report !== undefined) {
    if (report.run.id !== runId) {
      throw new Error(`Run ${runId} is not included in this static report.`);
    }
    const cursorIndex =
      cursor === undefined ? -1 : report.cases.findIndex(({ record }) => record.rowId === cursor);
    if (cursor !== undefined && cursorIndex === -1) {
      throw new Error('The static report case cursor is invalid.');
    }
    const startIndex = cursor === undefined ? 0 : cursorIndex + 1;
    const page = report.cases.slice(startIndex, startIndex + 250);
    const hasNextPage = startIndex + page.length < report.cases.length;
    return {
      items: page.map(({ summary }) => summary),
      nextCursor: hasNextPage ? page.at(-1)?.record.rowId : undefined,
    };
  }
  const query = new URLSearchParams({ limit: '250' });
  if (cursor !== undefined) query.set('cursor', cursor);
  const body = await fetchJson<ApiEnvelope & { items: CaseSummary[]; nextCursor?: string }>(
    `/api/runs/${segment(runId)}/cases?${query.toString()}`,
  );
  return { items: body.items, nextCursor: body.nextCursor };
};

const getCase = async (runId: string, suiteName: string, caseId: string): Promise<CaseRecord> => {
  const report = getReportData();
  const reportCase = report?.cases.find(
    ({ record }) =>
      record.runId === runId && record.suiteName === suiteName && record.caseId === caseId,
  );
  if (reportCase !== undefined) return reportCase.record;
  if (report !== undefined) {
    throw new Error(`Case ${suiteName}/${caseId} is not included in this static report.`);
  }
  const body = await fetchJson<ApiEnvelope & { case: CaseRecord }>(
    `/api/runs/${segment(runId)}/cases/${segment(suiteName)}/${segment(caseId)}`,
  );
  return body.case;
};

const getDiff = async (baseRunId: string, candidateRunId: string): Promise<RunDiff> => {
  if (getReportData() !== undefined) {
    throw new Error('Run comparisons require the live Attest dashboard.');
  }
  const body = await fetchJson<ApiEnvelope & { diff: RunDiff }>(
    `/api/diffs/${segment(baseRunId)}/${segment(candidateRunId)}`,
  );
  return body.diff;
};

export { getCase, getDiff, getRun, listCases, listRuns };
