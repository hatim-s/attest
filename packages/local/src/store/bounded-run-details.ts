import type { CaseRecord, RunStore } from '@attest/core';

import { MAX_CASE_SUMMARY_LIMIT } from './run-store.js';

/** Counts snapshot rows without hydrating blobs beyond the report's detail budget. */
const readBoundedRunDetails = async (
  store: RunStore,
  options: { runId: string; limit: number },
) => {
  const run = await store.getRun(options.runId);
  const cases: CaseRecord[] = [];
  let cursor: string | undefined;
  let totalCaseCount = 0;

  do {
    const page = await store.listCaseSummaries(options.runId, {
      cursor,
      limit: MAX_CASE_SUMMARY_LIMIT,
    });

    totalCaseCount += page.items.length;

    for (const item of page.items.slice(0, Math.max(0, options.limit - cases.length))) {
      cases.push(await store.getCase(options.runId, item.suiteName, item.caseId));
    }

    cursor = page.nextCursor;
  } while (cursor !== undefined);

  return { run, cases, totalCaseCount };
};

export { readBoundedRunDetails };
