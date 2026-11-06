import { EVAL_RUN_SCHEMA_ID, evalRunSchema, parseWithSchemaSync } from '@attest/contracts';

/** Unknown schemas have unknown coverage. Known schemas must satisfy their public contract. */
const plannedSuiteCases = (
  schemaId: string,
  configJson: string,
): ReadonlyMap<string, number> | null => {
  if (schemaId !== EVAL_RUN_SCHEMA_ID) return null;
  const { snapshot } = parseWithSchemaSync(evalRunSchema, JSON.parse(configJson));
  const counts = new Map(snapshot.selected_test_ids.map((id) => [id, 0]));
  const identities = new Set<string>();

  for (const selected of snapshot.selected_cases) {
    const key = JSON.stringify([selected.test_id, selected.case_id]);

    if (identities.has(key) || !counts.has(selected.test_id))
      throw new RangeError('Selected case identities disagree with selected tests.');
    identities.add(key);
    counts.set(selected.test_id, (counts.get(selected.test_id) ?? 0) + 1);
  }

  return counts;
};

export { plannedSuiteCases };
