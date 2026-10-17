import type { RunSource } from '@attest/core';
import { MAX_PAGE_LIMIT, type CaseSummary } from '@attest/core/records';

/** Aggregates must include every source page rather than only the default case window. */
const readCaseSummaries = async (source: RunSource, runId: string): Promise<CaseSummary[]> => {
  const summaries: CaseSummary[] = [];
  let cursor: string | undefined;

  do {
    const page = await source.listCaseSummaries(runId, { cursor, limit: MAX_PAGE_LIMIT });
    summaries.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  return summaries;
};

export { readCaseSummaries };
