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

export { historicalPlan };
