import type { RunSource } from '@attest/core';
import { toSuiteHistoryPoint, type SuiteHistory } from '../contract/responses.js';
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

    for (const [index, run] of page.items.entries()) {
      if (run.status === 'running') continue;
      runsExamined += 1;

      const point = toSuiteHistoryPoint(run, await readCaseSummaries(source, run.id), suiteName);

      if (point !== undefined) points.push(point);

      if (runsExamined === limit)
        return {
          suiteName,
          runsExamined,
          points,
          exhausted: page.nextCursor === undefined && index === page.items.length - 1,
        };
    }

    cursor = page.nextCursor;
  } while (cursor !== undefined);

  return { suiteName, runsExamined, points, exhausted: true };
};

export { readSuiteHistory };
