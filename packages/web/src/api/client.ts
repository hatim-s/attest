import type { CaseRecord, CaseSummary, RunDiff, RunRecord } from './types.js';
import { getReportData, type ReportData } from '../report/report-data.js';

type CasePage = { items: CaseSummary[]; nextCursor?: string };

type DashboardClient = {
  getCase: (runId: string, suiteName: string, caseId: string) => Promise<CaseRecord>;
  getDiff: (baseRunId: string, candidateRunId: string) => Promise<RunDiff>;
  getRun: (runId: string) => Promise<RunRecord>;
  listCases: (runId: string, cursor?: string) => Promise<CasePage>;
  listRuns: () => Promise<RunRecord[]>;
};

type ApiErrorEnvelope = { error?: { code?: string; message?: string } };

const CASE_PAGE_SIZE = 250;

/** Reads one JSON response and throws the server's error message on a non-2xx status. */
const fetchJson = async <T>(path: string): Promise<T> => {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  const body = (await response.json()) as T & ApiErrorEnvelope;
  if (!response.ok) {
    throw new Error(body.error?.message ?? `Attest API request failed (${response.status}).`);
  }
  return body;
};

/** Throws when a response field that should hold an object or array is missing. */
const requireField = <T extends object>(value: T | undefined, path: string): T => {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Attest API response at ${path} was malformed.`);
  }
  return value;
};

/** Reads from the loopback server started by `attest view`. */
const createHttpClient = (): DashboardClient => ({
  getCase: async (runId, suiteName, caseId) => {
    const path = `/api/runs/${encodeURIComponent(runId)}/cases/${encodeURIComponent(suiteName)}/${encodeURIComponent(caseId)}`;
    const body = await fetchJson<{ case: CaseRecord }>(path);
    return requireField(body.case, path);
  },
  getDiff: async (baseRunId, candidateRunId) => {
    const path = `/api/diffs/${encodeURIComponent(baseRunId)}/${encodeURIComponent(candidateRunId)}`;
    const body = await fetchJson<{ diff: RunDiff }>(path);
    return requireField(body.diff, path);
  },
  getRun: async (runId) => {
    const path = `/api/runs/${encodeURIComponent(runId)}`;
    const body = await fetchJson<{ run: RunRecord }>(path);
    return requireField(body.run, path);
  },
  listCases: async (runId, cursor) => {
    const query = new URLSearchParams({ limit: String(CASE_PAGE_SIZE) });
    if (cursor !== undefined) query.set('cursor', cursor);
    const path = `/api/runs/${encodeURIComponent(runId)}/cases?${query.toString()}`;
    const body = await fetchJson<CasePage>(path);
    return { items: requireField(body.items, path), nextCursor: body.nextCursor };
  },
  listRuns: async () => {
    const path = '/api/runs?limit=100';
    const body = await fetchJson<{ runs: RunRecord[] }>(path);
    return requireField(body.runs, path);
  },
});

const reject = <T>(message: string): Promise<T> => Promise.reject(new Error(message));

/** Reads from the data a static report embeds in `window.__ATTEST_REPORT__`. */
const createStaticClient = (report: ReportData): DashboardClient => {
  const missingRun = (runId: string) => `Run ${runId} is not included in this static report.`;
  return {
    getCase: (runId, suiteName, caseId) => {
      const reportCase = report.cases.find(
        ({ record }) =>
          record.runId === runId && record.suiteName === suiteName && record.caseId === caseId,
      );
      if (reportCase === undefined) {
        return reject(`Case ${suiteName}/${caseId} is not included in this static report.`);
      }
      return Promise.resolve(reportCase.record);
    },
    getDiff: () => reject('Run comparisons require the live Attest dashboard.'),
    getRun: (runId) => {
      if (report.run.id !== runId) return reject(missingRun(runId));
      return Promise.resolve(report.run);
    },
    listCases: (runId, cursor) => {
      if (report.run.id !== runId) return reject(missingRun(runId));
      const cursorIndex =
        cursor === undefined ? -1 : report.cases.findIndex(({ record }) => record.rowId === cursor);
      if (cursor !== undefined && cursorIndex === -1) {
        return reject('The static report case cursor is invalid.');
      }
      const startIndex = cursorIndex + 1;
      const page = report.cases.slice(startIndex, startIndex + CASE_PAGE_SIZE);
      const hasNextPage = startIndex + page.length < report.cases.length;
      return Promise.resolve({
        items: page.map(({ summary }) => summary),
        nextCursor: hasNextPage ? page.at(-1)?.record.rowId : undefined,
      });
    },
    listRuns: () => Promise.resolve([report.run]),
  };
};

const reportData = getReportData();
const client = reportData === undefined ? createHttpClient() : createStaticClient(reportData);
const { getCase, getDiff, getRun, listCases, listRuns } = client;

export { getCase, getDiff, getRun, listCases, listRuns };
