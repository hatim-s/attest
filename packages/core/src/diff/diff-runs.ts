import { EVAL_RUN_SCHEMA_ID, evalRunSchema, type EvalRun } from '@attest/contracts';

import { canonicalStringify } from '../store/internal/canonical-json.js';
import type { RunRecord, RunStore } from '../store/types.js';
import { classifyRuns } from './classify.js';
import type { RunDiff } from './types.js';

/** Selection scope of an eval run, used to decide whether unmatched cases are real changes. */
interface EvalScope {
  partial: boolean;
  tests: string[];
}

const isPartialSelection = (snapshot: EvalRun['snapshot']): boolean => {
  if (snapshot.selection === undefined) return false;
  return snapshot.selection.selected_cases < snapshot.selection.total_cases;
};

/** Reads selection metadata at the persisted JSON boundary; non-eval runs have no scope. */
const evalScope = (run: RunRecord): EvalScope | undefined => {
  if (run.schemaId !== EVAL_RUN_SCHEMA_ID) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(run.configJson);
  } catch {
    return undefined;
  }
  const parsed = evalRunSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { snapshot } = parsed.data;
  return {
    partial: isPartialSelection(snapshot),
    tests: snapshot.selected_test_ids.toSorted(),
  };
};

const hasSameTests = (base: EvalScope, candidate: EvalScope): boolean =>
  base.tests.length === candidate.tests.length &&
  base.tests.every((test, index) => test === candidate.tests[index]);

/**
 * Loads two runs and delegates their cases to the pure classifier. Runs over a partial or
 * different test selection compare only shared cases, so skipped cases never read as removals.
 */
const diffRuns = async (
  baseStore: RunStore,
  baseRunId: string,
  candidateRunId: string,
  candidateStore: RunStore = baseStore,
): Promise<RunDiff> => {
  const [base, candidate] = await Promise.all([
    baseStore.getRunWithCases(baseRunId),
    candidateStore.getRunWithCases(candidateRunId),
  ]);
  const baseScope = evalScope(base.run);
  const candidateScope = evalScope(candidate.run);
  const differentTests =
    baseScope !== undefined &&
    candidateScope !== undefined &&
    !hasSameTests(baseScope, candidateScope);
  return classifyRuns(base.cases, candidate.cases, {
    baseRunId,
    candidateRunId,
    baseConfigHash: base.run.configHash,
    candidateConfigHash: candidate.run.configHash,
    sharedOnly: baseScope?.partial === true || candidateScope?.partial === true || differentTests,
  });
};

/** Serializes a diff with recursively stable object-key ordering for byte-stable CLI output. */
const diffToJson = (diff: RunDiff): string => canonicalStringify(diff);

export { diffRuns, diffToJson };
