import {
  caseRecordSchema,
  caseSummarySchema,
  runDiffSchema,
  runRecordSchema,
} from '@attest/core/records';
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

type ResponseDecoder<T> = {
  /** BOUNDARY: validates a response body against the endpoint's domain contract. */
  (value: unknown): T;
};

const isString = (value: unknown): value is string => typeof value === 'string';

/** BOUNDARY: inspects HTTP response objects before their endpoint schema validates the fields. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const CASE_PAGE_SIZE = 250;

/** BOUNDARY: accepts untrusted HTTP JSON, checks the envelope, and parses its endpoint payload. */
const decodeCase = (value: unknown): CaseRecord => {
  if (!isRecord(value)) throw new Error('Malformed case response.');

  return caseRecordSchema.parse(value.case);
};

/** BOUNDARY: validates the run endpoint's envelope and stored run fields. */
const decodeRun = (value: unknown): RunRecord => {
  if (!isRecord(value)) throw new Error('Malformed run response.');

  return runRecordSchema.parse(value.run);
};

/** BOUNDARY: validates the diff endpoint's envelope and comparison fields. */
const decodeDiff = (value: unknown): RunDiff => {
  if (!isRecord(value)) throw new Error('Malformed diff response.');

  return runDiffSchema.parse(value.diff);
};

/** BOUNDARY: validates the run list and each stored run before rendering. */
const decodeRuns = (value: unknown): RunRecord[] => {
  if (!isRecord(value) || !Array.isArray(value.runs))
    throw new Error('Attest API response run list was malformed.');

  return value.runs.map((run) => runRecordSchema.parse(run));
};

/** BOUNDARY: validates the case page, summary records, and optional pagination cursor. */
const decodeCasePage = (value: unknown): CasePage => {
  if (!isRecord(value) || !Array.isArray(value.items))
    throw new Error('Attest API response case page was malformed.');
  const page: CasePage = { items: value.items.map((item) => caseSummarySchema.parse(item)) };

  if (value.nextCursor !== undefined) {
    if (!isString(value.nextCursor)) throw new Error('Malformed case page cursor.');
    page.nextCursor = value.nextCursor;
  }

  return page;
};

/** BOUNDARY: reads only a validated string message from a server error envelope. */
const errorMessage = (value: unknown): string | undefined => {
  if (!isRecord(value) || !isRecord(value.error)) return undefined;

  return isString(value.error.message) ? value.error.message : undefined;
};

/** Reads one JSON response, reports HTTP errors, and decodes a successful endpoint payload. */
const fetchJson = async <T>(path: string, decode: ResponseDecoder<T>): Promise<T> => {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  const body: unknown = await response.json();

  if (!response.ok)
    throw new Error(errorMessage(body) ?? `Attest API request failed (${response.status}).`);

  return decode(body);
};

/** Reads from the loopback server started by `attest view`. */
const createHttpClient = (): DashboardClient => ({
  getCase: async (runId, suiteName, caseId) => {
    const path = `/api/runs/${encodeURIComponent(runId)}/cases/${encodeURIComponent(suiteName)}/${encodeURIComponent(caseId)}`;

    return fetchJson(path, decodeCase);
  },
  getDiff: async (baseRunId, candidateRunId) => {
    const path = `/api/diffs/${encodeURIComponent(baseRunId)}/${encodeURIComponent(candidateRunId)}`;

    return fetchJson(path, decodeDiff);
  },
  getRun: async (runId) => {
    const path = `/api/runs/${encodeURIComponent(runId)}`;

    return fetchJson(path, decodeRun);
  },
  listCases: async (runId, cursor) => {
    const query = new URLSearchParams({ limit: String(CASE_PAGE_SIZE) });

    if (cursor !== undefined) query.set('cursor', cursor);
    const path = `/api/runs/${encodeURIComponent(runId)}/cases?${query.toString()}`;

    return fetchJson(path, decodeCasePage);
  },
  listRuns: async () => {
    const path = '/api/runs?limit=100';

    return fetchJson(path, decodeRuns);
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
