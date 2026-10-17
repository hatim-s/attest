import { EVAL_RUN_SCHEMA_ID, evalRunSchema, type EvalRun } from '@attest/contracts';

import { canonicalStringify } from '../store/internal/canonical-json.js';
import { StoreError } from '../store/store-error.js';
import type { RunRecord, RunSource } from '../store/types.js';
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

/**
 * Reads selection metadata from a stored eval run; non-eval runs have no scope. A config that does
 * not parse is corrupt, since treating it as a full selection would report skipped cases as removals.
 */
const evalScope = (run: RunRecord): EvalScope | undefined => {
  if (run.schemaId !== EVAL_RUN_SCHEMA_ID) return undefined;
  let snapshot: EvalRun['snapshot'];

  try {
    snapshot = evalRunSchema.parse(JSON.parse(run.configJson)).snapshot;
  } catch (error) {
    throw new StoreError('CORRUPT_DATA', `Run ${run.id} has an unreadable eval configuration.`, {
      cause: error,
    });
  }

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
  source: Pick<RunSource, 'getRunWithCases'>,
  baseRunId: string,
  candidateRunId: string,
): Promise<RunDiff> => {
  const [base, candidate] = await Promise.all([
    source.getRunWithCases(baseRunId),
    source.getRunWithCases(candidateRunId),
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
