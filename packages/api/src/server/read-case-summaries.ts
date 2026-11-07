import * as Effect from 'effect/Effect';
import type { RunSource, StoreError } from '@attest/core';
import { MAX_PAGE_LIMIT, type CaseSummary } from '@attest/core/records';

/** Aggregates must include every source page rather than only the default case window. */
const readCaseSummaries = Effect.fn('readCaseSummaries')(function* (
  source: RunSource,
  runId: string,
): Effect.fn.Return<CaseSummary[], StoreError> {
  const summaries: CaseSummary[] = [];
  let cursor: string | undefined;

  do {
    const page = yield* source.listCaseSummaries(runId, { cursor, limit: MAX_PAGE_LIMIT });
    summaries.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  return summaries;
});

export { readCaseSummaries };
