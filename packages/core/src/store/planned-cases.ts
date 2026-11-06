import { EVAL_RUN_SCHEMA_ID, evalRunSchema, parseWithSchemaSync } from '@attest/contracts';

/** Derives exact membership and counts once from either strict live or narrow historical input. */
const deriveSelectedCases = (snapshot: {
  selected_test_ids: readonly string[];
  selected_cases: readonly { test_id: string; case_id: string }[];
}): ReadonlyMap<string, ReadonlySet<string>> => {
  const suites = new Map(snapshot.selected_test_ids.map((id) => [id, new Set<string>()]));

  for (const selected of snapshot.selected_cases) {
    const cases = suites.get(selected.test_id);

    if (!cases || cases.has(selected.case_id))
      throw new RangeError(
        `Contradictory selection identities, suite ${selected.test_id}, case ${selected.case_id}.`,
      );
    cases.add(selected.case_id);
  }

  return suites;
};

/** Unknown schemas have unknown coverage. Known schemas must satisfy their public contract. */
const plannedCaseSelection = (schemaId: string, configJson: string) => {
  if (schemaId !== EVAL_RUN_SCHEMA_ID) return null;

  return deriveSelectedCases(parseWithSchemaSync(evalRunSchema, JSON.parse(configJson)).snapshot);
};

/** Counts share the identity derivation used by storage membership checks. */
const plannedSuiteCases = (
  schemaId: string,
  configJson: string,
): ReadonlyMap<string, number> | null => {
  const plan = plannedCaseSelection(schemaId, configJson);

  return plan === null ? null : new Map([...plan].map(([suite, cases]) => [suite, cases.size]));
};

export { deriveSelectedCases, plannedCaseSelection, plannedSuiteCases };
