import { indexedTimestampSchema } from '@attest/core/records';
import * as Schema from 'effect/Schema';
import { stripStruct } from '@attest/contracts';
import { parseWithSchemaSync } from '@attest/contracts';
import { StoreError, deriveSelectedCases } from '@attest/core';

const historicalPlanSchema = stripStruct({
  snapshot: stripStruct({
    selected_test_ids: Schema.Array(Schema.String),
    selected_cases: Schema.Array(stripStruct({ test_id: Schema.String, case_id: Schema.String })),
  }),
});

/** Canonical indexed time; callers choose the error at the input boundary. */
const canonicalTime = (
  value: string,
  code: 'INVALID_RECORD' | 'CORRUPT_DATA' | 'INVALID_LIMIT',
): string => {
  try {
    parseWithSchemaSync(indexedTimestampSchema, value);
  } catch (cause) {
    throw new StoreError(code, `Invalid timestamp: ${value}`, { cause });
  }

  const time = Date.parse(value);

  if (!Number.isFinite(time)) throw new StoreError(code, `Invalid timestamp: ${value}`);

  return new Date(time).toISOString();
};

/** Historical coverage depends only on selection identity, never today's command schema. */
const historicalPlan = (
  json: string,
  runId: string,
): ReadonlyMap<string, ReadonlySet<string>> | null => {
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

  try {
    return deriveSelectedCases(snapshot);
  } catch (cause) {
    throw new StoreError(
      'CORRUPT_DATA',
      `Contradictory selection in run ${runId}: ${String(cause)}`,
      { cause },
    );
  }
};

/** Shared activity bounds for persisted and empty registry sources. */
const activityBounds = (query: { from: string; to: string }) => {
  const from = canonicalTime(query.from, 'INVALID_LIMIT');
  const to = canonicalTime(query.to, 'INVALID_LIMIT');

  if (to <= from || Date.parse(to) - Date.parse(from) > 92 * 86400000)
    throw new StoreError('INVALID_LIMIT', 'Activity requires an interval of at most 92 days.');

  return { from, to };
};

export { canonicalTime, historicalPlan, activityBounds };
