import { aggregateCases, summarizeSuites } from '@attest/core/analytics';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, type PageQuery } from '@attest/core/records';
import { API_ERROR_STATUS, type ApiErrorCode } from '../contract/errors.js';
import type { ReportSnapshot } from '../contract/snapshot.js';
import type { ApiClient } from './api-client.js';
import { ApiError } from './api-error.js';

const reject = (code: ApiErrorCode, message: string): never => {
  throw new ApiError(API_ERROR_STATUS[code], code, message);
};

const pageLimit = (query: PageQuery): number => {
  const limit = query.limit ?? DEFAULT_PAGE_LIMIT;

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    return reject('INVALID_REQUEST', `Page limit must be an integer from 1 to ${MAX_PAGE_LIMIT}.`);
  }

  return limit;
};

/** Reads the already parsed bootstrap without making network requests from offline reports. */
const createSnapshotClient = (snapshot: ReportSnapshot): ApiClient => {
  const requireRun = (runId: string) => {
    if (snapshot.run.id !== runId)
      reject('RUN_NOT_FOUND', `Run ${runId} is not included in this report.`);

    return snapshot.run;
  };

  return {
    mode: {
      kind: 'snapshot',
      generatedAt: snapshot.generatedAt,
      includedCases: snapshot.cases.length,
      truncated: snapshot.truncated,
    },
    listRuns: async (query) => {
      pageLimit(query);

      if (query.cursor === undefined) return Promise.resolve({ items: [snapshot.run] });

      if (query.cursor === snapshot.run.id) return Promise.resolve({ items: [] });

      return reject('INVALID_CURSOR', `Run cursor ${query.cursor} is unknown.`);
    },
    getRun: async ({ runId }) => Promise.resolve(requireRun(runId)),
    listCaseSummaries: async ({ runId }, query) => {
      requireRun(runId);
      const limit = pageLimit(query);

      const index =
        query.cursor === undefined
          ? -1
          : snapshot.cases.findIndex(({ record }) => record.rowId === query.cursor);

      if (query.cursor !== undefined && index === -1)
        reject('INVALID_CURSOR', `Case cursor ${query.cursor} is unknown.`);
      const page = snapshot.cases.slice(index + 1, index + 1 + limit);
      const items = page.map(({ summary }) => summary);

      return Promise.resolve(
        index + 1 + page.length < snapshot.cases.length
          ? { items, nextCursor: page.at(-1)?.record.rowId }
          : { items },
      );
    },
    getCase: async ({ runId, suiteName, caseId }) => {
      requireRun(runId);

      const found = snapshot.cases.find(
        ({ record }) => record.suiteName === suiteName && record.caseId === caseId,
      );

      if (found === undefined)
        return reject(
          'CASE_NOT_FOUND',
          `Case ${suiteName}/${caseId} is not included in this report.`,
        );

      return Promise.resolve(found.record);
    },
    listRunSuites: async ({ runId }) => {
      requireRun(runId);

      return Promise.resolve({
        runId,
        suites: summarizeSuites(snapshot.cases.map(({ summary }) => summary)),
      });
    },
    getSuiteHistory: async ({ suiteName }) => {
      const run = snapshot.run;

      if (run.status === 'running')
        return Promise.resolve({ suiteName, runsExamined: 0, points: [] });

      const [first, ...rest] = snapshot.cases
        .map(({ summary }) => summary)
        .filter((summary) => summary.suiteName === suiteName);

      const points =
        first === undefined
          ? []
          : [
              {
                runId: run.id,
                createdAt: run.createdAt,
                status: run.status,
                gitBranch: run.gitBranch,
                gitSha: run.gitSha,
                aggregate: aggregateCases([first, ...rest]),
              },
            ];

      return Promise.resolve({ suiteName, runsExamined: 1, points });
    },
    getDiff: ({ baseRunId, candidateRunId }) =>
      Promise.resolve().then(() => {
        if (baseRunId === candidateRunId)
          return reject('INVALID_REQUEST', 'baseRunId and candidateRunId must differ.');
        requireRun(baseRunId);
        requireRun(candidateRunId);

        return reject('RUN_NOT_FOUND', 'The comparison run is not included in this report.');
      }),
  };
};

export { createSnapshotClient };
