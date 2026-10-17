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
  getCase: (
    runId: string,
    identity: Pick<CaseSummary, 'suiteName' | 'caseId'>,
    signal?: AbortSignal,
  ) => Promise<CaseRecord>;
  getDiff: (baseRunId: string, candidateRunId: string, signal?: AbortSignal) => Promise<RunDiff>;
  getRun: (runId: string, signal?: AbortSignal) => Promise<RunRecord>;
  listCases: (runId: string, cursor?: string, signal?: AbortSignal) => Promise<CasePage>;
  listRuns: (signal?: AbortSignal) => Promise<RunRecord[]>;
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

/** Carries HTTP status independently of whether a proxy returned a JSON error envelope. */
class DashboardHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'DashboardHttpError';
  }
}

/** Reads HTTP failures before endpoint decoding so non-JSON bodies retain their status. */
const fetchJson = async <T>(
  path: string,
  decode: ResponseDecoder<T>,
  signal: AbortSignal | undefined,
): Promise<T> => {
  const response = await fetch(path, { headers: { Accept: 'application/json' }, signal });

  if (!response.ok) {
    let body: unknown;

    try {
      body = await response.json();
    } catch {
      signal?.throwIfAborted();
      throw new DashboardHttpError(
        response.status,
        undefined,
        `Attest API request failed (${response.status}).`,
      );
    }

    const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
    throw new DashboardHttpError(
      response.status,
      isString(error?.code) ? error.code : undefined,
      isString(error?.message) ? error.message : `Attest API request failed (${response.status}).`,
    );
  }

  const body: unknown = await response.json();

  return decode(body);
};

/** Reads from the loopback server started by `attest view`. */
const createHttpClient = (): DashboardClient => ({
  getCase: async (runId, { suiteName, caseId }, signal) => {
    const path = `/api/runs/${encodeURIComponent(runId)}/cases/${encodeURIComponent(suiteName)}/${encodeURIComponent(caseId)}`;

    return fetchJson(path, decodeCase, signal);
  },
  getDiff: async (baseRunId, candidateRunId, signal) => {
    const path = `/api/diffs/${encodeURIComponent(baseRunId)}/${encodeURIComponent(candidateRunId)}`;

    return fetchJson(path, decodeDiff, signal);
  },
  getRun: async (runId, signal) => {
    const path = `/api/runs/${encodeURIComponent(runId)}`;

    return fetchJson(path, decodeRun, signal);
  },
  listCases: async (runId, cursor, signal) => {
    const query = new URLSearchParams({ limit: String(CASE_PAGE_SIZE) });

    if (cursor !== undefined) query.set('cursor', cursor);
    const path = `/api/runs/${encodeURIComponent(runId)}/cases?${query.toString()}`;

    return fetchJson(path, decodeCasePage, signal);
  },
  listRuns: async (signal) => {
    const path = '/api/runs?limit=100';

    return fetchJson(path, decodeRuns, signal);
  },
});

const reject = <T>(message: string): Promise<T> => Promise.reject(new Error(message));

/** Reads from the data a static report embeds in `window.__ATTEST_REPORT__`. */
const createStaticClient = (report: ReportData): DashboardClient => {
  const missingRun = (runId: string) => `Run ${runId} is not included in this static report.`;

  return {
    getCase: (runId, { suiteName, caseId }) => {
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

export { DashboardHttpError, getCase, getDiff, getRun, listCases, listRuns };
