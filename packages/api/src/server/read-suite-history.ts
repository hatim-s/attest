import type { RunSource } from '@attest/core';
import { aggregateCases } from '@attest/core/analytics';
import type { SuiteHistory } from '../contract/responses.js';
import { readCaseSummaries } from './read-case-summaries.js';

/** Bounds history work by completed runs examined, including runs that lack this suite. */
const readSuiteHistory = async (
  source: RunSource,
  suiteName: string,
  limit: number,
): Promise<SuiteHistory> => {
  const points: SuiteHistory['points'] = [];
  let runsExamined = 0;
  let cursor: string | undefined;

  do {
    const page = await source.listRuns({ cursor, limit: limit - runsExamined });

    for (const run of page.items) {
      if (run.status === 'running') continue;
      runsExamined += 1;

      const summaries = (await readCaseSummaries(source, run.id)).filter(
        (summary) => summary.suiteName === suiteName,
      );

      const [first, ...rest] = summaries;

      if (first !== undefined)
        points.push({
          runId: run.id,
          createdAt: run.createdAt,
          status: run.status,
          gitBranch: run.gitBranch,
          gitSha: run.gitSha,
          aggregate: aggregateCases([first, ...rest]),
        });

      if (runsExamined === limit) return { suiteName, runsExamined, points };
    }

    cursor = page.nextCursor;
  } while (cursor !== undefined);

  return { suiteName, runsExamined, points };
};

export { readSuiteHistory };
