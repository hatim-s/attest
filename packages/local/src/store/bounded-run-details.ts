import * as Effect from 'effect/Effect';
import { MAX_PAGE_LIMIT, type CaseRecord, type RunStore } from '@attest/core';

/** Counts snapshot rows without hydrating blobs beyond the report's detail budget. */
const readBoundedRunDetails = Effect.fn('readBoundedRunDetails')(function* (
  store: RunStore,
  options: { runId: string; limit: number },
) {
  const run = yield* store.getRun(options.runId);
  const cases: CaseRecord[] = [];
  let cursor: string | undefined;
  let totalCaseCount = 0;

  do {
    const page = yield* store.listCaseSummaries(options.runId, {
      cursor,
      limit: MAX_PAGE_LIMIT,
    });

    totalCaseCount += page.items.length;

    for (const item of page.items.slice(0, Math.max(0, options.limit - cases.length))) {
      cases.push(yield* store.getCase(options.runId, item.suiteName, item.caseId));
    }

    cursor = page.nextCursor;
  } while (cursor !== undefined);

  return { run, cases, totalCaseCount };
});

export { readBoundedRunDetails };
