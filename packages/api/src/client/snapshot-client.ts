import * as Effect from 'effect/Effect';
import { EVAL_RUN_SCHEMA_ID } from '@attest/contracts';
import {
  addCaseToTotals,
  bucketActivity,
  emptySliceTotals,
  summarizeEvalSlices,
  toEvalSlice,
} from '@attest/core/analytics';
import {
  activityBounds,
  canonicalTime,
  parsePageLimit,
  plannedSuiteCases,
  StoreError,
  type CaseSummary,
  type EvalSlice,
  type PageQuery,
  type SliceTotals,
} from '@attest/core/records';
import { API_ERROR_STATUS, type ApiErrorCode } from '../contract/errors.js';
import type { ReportSnapshot } from '../contract/snapshot.js';
import type { ApiClient } from './api-client.js';
import { ApiError } from './api-error.js';

const fail = (code: ApiErrorCode, message: string): never => {
  throw new ApiError(API_ERROR_STATUS[code], code, message);
};

/** Evaluates pure snapshot algorithms only when the native operation runs. */
const settle = <T>(read: () => T) =>
  Effect.try({
    try: read,
    catch: (error) => {
      if (error instanceof StoreError && error.code === 'INVALID_LIMIT')
        return new ApiError(API_ERROR_STATUS.INVALID_REQUEST, 'INVALID_REQUEST', error.message);

      if (error instanceof ApiError) return error;
      throw error;
    },
  });

const controlUnavailable = () =>
  Effect.fail(
    new ApiError(
      API_ERROR_STATUS.CONTROL_UNAVAILABLE,
      'CONTROL_UNAVAILABLE',
      'A saved report cannot start or cancel runs.',
    ),
  );

/** Pages an already ordered list by the key of its last item, like the stores' keyset cursors. */
const pageBy = <T>(items: readonly T[], key: (item: T) => string, query: PageQuery) => {
  const limit = parsePageLimit(query);

  const index =
    query.cursor === undefined ? -1 : items.findIndex((item) => key(item) === query.cursor);

  if (query.cursor !== undefined && index === -1)
    return fail('INVALID_CURSOR', `Cursor ${query.cursor} is unknown.`);
  const page = items.slice(index + 1, index + 1 + limit);
  const last = page.at(-1);

  return index + 1 + page.length < items.length && last !== undefined
    ? { items: page, nextCursor: key(last) }
    : { items: page };
};

/** Same cell rule as the stores: a case the run cancelled was skipped, not errored. */
const toCell = (summary: CaseSummary) =>
  summary.outcome === 'cancelled' ? ('skipped' as const) : summary.verdict;

/**
 * Builds one eval slice per suite from the report's case summaries with the core totals rules.
 * A truncated report omits cases, so its plan is treated as unknown rather than reporting the
 * omitted cases as not run. Suites outside the plan get an unknown plan, as in the stores.
 */
const buildSlices = (snapshot: ReportSnapshot): EvalSlice[] => {
  const { run } = snapshot;

  if (run.schemaId !== EVAL_RUN_SCHEMA_ID) return [];
  const planned = snapshot.truncated ? null : plannedSuiteCases(run.schemaId, run.configJson);

  const totals = new Map<string, SliceTotals>(
    [...(planned ?? [])].map(([suite, count]) => [suite, emptySliceTotals(count)]),
  );

  for (const { summary } of snapshot.cases)
    totals.set(
      summary.suiteName,
      addCaseToTotals(totals.get(summary.suiteName) ?? emptySliceTotals(null), summary),
    );

  return [...totals]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([suite, suiteTotals]) => toEvalSlice(suiteTotals, run, suite));
};

/** Reads the already parsed bootstrap without making network requests from offline reports. */
const createSnapshotClient = (snapshot: ReportSnapshot): ApiClient => {
  const slices = buildSlices(snapshot);
  const summaries = snapshot.cases.map(({ summary }) => summary);
  const runCreatedAt = canonicalTime(snapshot.run.createdAt, 'CORRUPT_DATA');

  const requireProject = (projectKey: string): void => {
    if (snapshot.project.key !== projectKey)
      fail('PROJECT_NOT_FOUND', `Project ${projectKey} is not included in this report.`);
  };

  const requireRun = (projectKey: string, runId: string) => {
    requireProject(projectKey);

    if (snapshot.run.id !== runId)
      return fail('RUN_NOT_FOUND', `Run ${runId} is not included in this report.`);

    return snapshot.run;
  };

  const sliceOf = (suiteName: string) => slices.find((slice) => slice.suiteName === suiteName);

  const evalPage = (query: PageQuery) =>
    pageBy(
      slices.map((slice) =>
        summarizeEvalSlices(
          slice,
          slice.state === 'complete' ? slice : null,
          slice.state === 'incomplete' ? slice : null,
        ),
      ),
      (summary) => summary.suiteName,
      query,
    );

  const overview = () => ({
    evals: evalPage({ limit: 500 }),
    runningRunCount: slices.length > 0 && snapshot.run.status === 'running' ? 1 : 0,
    runningRunCountTruncated: false,
    lastRunAt: slices.length > 0 ? runCreatedAt : null,
  });

  return {
    mode: {
      kind: 'snapshot',
      generatedAt: snapshot.generatedAt,
      includedCases: snapshot.cases.length,
      truncated: snapshot.truncated,
    },
    capabilities: { control: false },
    listOverviews: () =>
      settle(() => ({
        items: [{ status: 'ready' as const, project: snapshot.project, overview: overview() }],
      })),
    listProjects: () => settle(() => ({ items: [snapshot.project] })),
    getProjectOverview: ({ projectKey }) =>
      settle(() => {
        requireProject(projectKey);

        return overview();
      }),
    listEvals: ({ projectKey }, query) =>
      settle(() => {
        requireProject(projectKey);

        return evalPage(query);
      }),
    listEvalRuns: ({ projectKey, suiteName }, query) =>
      settle(() => {
        requireProject(projectKey);

        const since =
          query.since === undefined ? undefined : canonicalTime(query.since, 'INVALID_LIMIT');

        const until =
          query.until === undefined ? undefined : canonicalTime(query.until, 'INVALID_LIMIT');

        if (since !== undefined && until !== undefined && since >= until)
          throw new StoreError('INVALID_LIMIT', 'Expected since before until.');
        const slice = sliceOf(suiteName);

        const inWindow =
          (since === undefined || runCreatedAt >= since) &&
          (until === undefined || runCreatedAt < until);

        return pageBy(slice !== undefined && inWindow ? [slice] : [], (item) => item.runId, query);
      }),
    getEvalCaseWindow: ({ projectKey, suiteName }, query) =>
      settle(() => {
        requireProject(projectKey);
        const slice = sliceOf(suiteName);

        const cases = summaries
          .filter((summary) => summary.suiteName === suiteName)
          .sort((a, b) => a.caseId.localeCompare(b.caseId))
          .map((summary) => ({ caseId: summary.caseId, cells: [toCell(summary)] }));

        return {
          runs: slice === undefined ? [] : [slice],
          ...pageBy(cases, (item) => item.caseId, query),
        };
      }),
    getCaseHistory: ({ projectKey, suiteName, caseId }, query) =>
      settle(() => {
        requireProject(projectKey);

        const summary = summaries.find(
          (item) => item.suiteName === suiteName && item.caseId === caseId,
        );

        const items =
          summary === undefined || sliceOf(suiteName) === undefined
            ? []
            : [
                {
                  runId: snapshot.run.id,
                  createdAt: runCreatedAt,
                  runStatus: snapshot.run.status,
                  cell: toCell(summary),
                  durationMs: summary.durationMs,
                },
              ];

        return pageBy(items, (item) => item.runId, query);
      }),
    getActivity: ({ projectKey }, query) =>
      settle(() => {
        requireProject(projectKey);
        const bounds = activityBounds(query);
        const inWindow = runCreatedAt >= bounds.from && runCreatedAt < bounds.to;

        return bucketActivity(
          inWindow ? slices.map(({ counts }) => ({ createdAt: runCreatedAt, ...counts })) : [],
          bounds,
        );
      }),
    listRuns: ({ projectKey }, query) =>
      settle(() => {
        requireProject(projectKey);

        return pageBy([snapshot.run], (run) => run.id, query);
      }),
    getRun: ({ projectKey, runId }) => settle(() => requireRun(projectKey, runId)),
    listCaseSummaries: ({ projectKey, runId }, query) =>
      settle(() => {
        requireRun(projectKey, runId);

        const cases = snapshot.cases.filter(
          ({ record }) => query.suiteName === undefined || record.suiteName === query.suiteName,
        );

        const page = pageBy(cases, ({ record }) => record.rowId, query);

        return { ...page, items: page.items.map(({ summary }) => summary) };
      }),
    getCase: ({ projectKey, runId, suiteName, caseId }) =>
      settle(() => {
        requireRun(projectKey, runId);

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
    listRunSuites: ({ projectKey, runId }) =>
      settle(() => {
        requireRun(projectKey, runId);

        return { runId, suites: slices };
      }),
    getDiff: ({ projectKey, baseRunId, candidateRunId }) =>
      settle(() => {
        requireProject(projectKey);

        if (baseRunId === candidateRunId)
          return fail('INVALID_REQUEST', 'baseRunId and candidateRunId must differ.');
        requireRun(projectKey, baseRunId);
        requireRun(projectKey, candidateRunId);

        return fail('RUN_NOT_FOUND', 'The comparison run is not included in this report.');
      }),
    listTests: controlUnavailable,
    startRun: controlUnavailable,
    cancelRun: controlUnavailable,
  };
};

export { createSnapshotClient };
