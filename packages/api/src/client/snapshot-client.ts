import { pageQuerySchema, type PageQuery } from '@attest/core/records';
import { API_ERROR_STATUS, type ApiErrorCode } from '../contract/errors.js';
import type { ReportSnapshot } from '../contract/snapshot.js';
import type { ApiClient } from './api-client.js';
import { ApiError } from './api-error.js';

const fail = (code: ApiErrorCode, message: string): never => {
  throw new ApiError(API_ERROR_STATUS[code], code, message);
};

const pageLimit = (query: PageQuery): number => {
  const parsed = pageQuerySchema.shape.limit.safeParse(query.limit);

  if (!parsed.success)
    return fail('INVALID_REQUEST', parsed.error.issues[0]?.message ?? parsed.error.message);

  return parsed.data;
};

/** Makes synchronous snapshot failures reject through the same promise contract as HTTP. */
const settle = <T>(read: () => T): Promise<T> => Promise.resolve().then(read);

/** Reads the already parsed bootstrap without making network requests from offline reports. */
const createSnapshotClient = (snapshot: ReportSnapshot): ApiClient => {
  const requireRun = (runId: string) => {
    if (snapshot.run.id !== runId)
      return fail('RUN_NOT_FOUND', `Run ${runId} is not included in this report.`);

    return snapshot.run;
  };

  return {
    mode: {
      kind: 'snapshot',
      generatedAt: snapshot.generatedAt,
      includedCases: snapshot.cases.length,
      truncated: snapshot.truncated,
    },
    listRuns: (query) =>
      settle(() => {
        pageLimit(query);

        if (query.cursor === undefined) return { items: [snapshot.run] };

        if (query.cursor === snapshot.run.id) return { items: [] };

        return fail('INVALID_CURSOR', `Run cursor ${query.cursor} is unknown.`);
      }),
    getRun: ({ runId }) => settle(() => requireRun(runId)),
    listCaseSummaries: ({ runId }, query) =>
      settle(() => {
        requireRun(runId);
        const limit = pageLimit(query);

        const index =
          query.cursor === undefined
            ? -1
            : snapshot.cases.findIndex(({ record }) => record.rowId === query.cursor);

        if (query.cursor !== undefined && index === -1)
          return fail('INVALID_CURSOR', `Case cursor ${query.cursor} is unknown.`);
        const page = snapshot.cases.slice(index + 1, index + 1 + limit);
        const items = page.map(({ summary }) => summary);

        return index + 1 + page.length < snapshot.cases.length
          ? { items, nextCursor: page.at(-1)?.record.rowId }
          : { items };
      }),
    getCase: ({ runId, suiteName, caseId }) =>
      settle(() => {
        requireRun(runId);

        const found = snapshot.cases.find(
          ({ record }) => record.suiteName === suiteName && record.caseId === caseId,
        );

        if (found === undefined)
          return fail(
            'CASE_NOT_FOUND',
            `Case ${suiteName}/${caseId} is not included in this report.`,
          );

        return found.record;
      }),
    getDiff: ({ baseRunId, candidateRunId }) =>
      settle(() => {
        if (baseRunId === candidateRunId)
          return fail('INVALID_REQUEST', 'baseRunId and candidateRunId must differ.');
        requireRun(baseRunId);
        requireRun(candidateRunId);

        return fail('RUN_NOT_FOUND', 'The comparison run is not included in this report.');
      }),
  };
};

export { createSnapshotClient };
