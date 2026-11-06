import { z } from 'zod';
import { parseWithSchemaSync } from '@attest/contracts';
import { StoreError } from '@attest/core';

const historicalPlanSchema = z.object({
  snapshot: z.object({
    selected_test_ids: z.array(z.string()),
    selected_cases: z.array(z.object({ test_id: z.string(), case_id: z.string() })),
  }),
});

/** Canonical indexed time; callers choose the error at the input boundary. */
const canonicalTime = (
  value: string,
  code: 'INVALID_RECORD' | 'CORRUPT_DATA' | 'INVALID_LIMIT',
): string => {
  try {
    parseWithSchemaSync(z.iso.datetime({ offset: true }), value);
  } catch (cause) {
    throw new StoreError(code, `Invalid timestamp: ${value}`, { cause });
  }

  const time = Date.parse(value);

  if (!Number.isFinite(time)) throw new StoreError(code, `Invalid timestamp: ${value}`);

  return new Date(time).toISOString();
};

/** Historical coverage depends only on selection identity, never today's command schema. */
const historicalPlan = (json: string, runId: string): ReadonlyMap<string, number> | null => {
  let value: unknown;

  try {
    value = JSON.parse(json);
  } catch (cause) {
    throw new StoreError('CORRUPT_DATA', `Invalid snapshot JSON in run ${runId}.`, { cause });
  }

  let snapshot;

  try {
    snapshot = parseWithSchemaSync(historicalPlanSchema, value).snapshot;
  } catch {
    return null;
  }

  const counts = new Map(snapshot.selected_test_ids.map((id) => [id, 0]));
  const seen = new Set<string>();

  for (const row of snapshot.selected_cases) {
    const key = JSON.stringify([row.test_id, row.case_id]);

    if (!counts.has(row.test_id) || seen.has(key))
      throw new StoreError(
        'CORRUPT_DATA',
        `Contradictory selection in run ${runId}, suite ${row.test_id}.`,
      );
    seen.add(key);
    counts.set(row.test_id, (counts.get(row.test_id) ?? 0) + 1);
  }

  return counts;
};

export { canonicalTime, historicalPlan };
