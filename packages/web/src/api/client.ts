import type { CaseRecord, CaseSummary, RunDiff, RunRecord } from './types.js';

type ApiEnvelope = { api_version: 'attest.view/v1' };
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
  const body = await fetchJson<ApiEnvelope & { runs: RunRecord[] }>('/api/v1/runs?limit=100');
  return body.runs;
};

const getRun = async (runId: string): Promise<RunRecord> => {
  const body = await fetchJson<ApiEnvelope & { run: RunRecord }>(`/api/v1/runs/${segment(runId)}`);
  return body.run;
};

const listCases = async (
  runId: string,
  cursor?: string,
): Promise<{ items: CaseSummary[]; nextCursor?: string }> => {
  const query = new URLSearchParams({ limit: '250' });
  if (cursor !== undefined) query.set('cursor', cursor);
  const body = await fetchJson<ApiEnvelope & { items: CaseSummary[]; nextCursor?: string }>(
    `/api/v1/runs/${segment(runId)}/cases?${query.toString()}`,
  );
  return { items: body.items, nextCursor: body.nextCursor };
};

const getCase = async (runId: string, suiteName: string, caseId: string): Promise<CaseRecord> => {
  const body = await fetchJson<ApiEnvelope & { case: CaseRecord }>(
    `/api/v1/runs/${segment(runId)}/cases/${segment(suiteName)}/${segment(caseId)}`,
  );
  return body.case;
};

const getDiff = async (baseRunId: string, candidateRunId: string): Promise<RunDiff> => {
  const body = await fetchJson<ApiEnvelope & { diff: RunDiff }>(
    `/api/v1/diffs/${segment(baseRunId)}/${segment(candidateRunId)}`,
  );
  return body.diff;
};

export { getCase, getDiff, getRun, listCases, listRuns };
