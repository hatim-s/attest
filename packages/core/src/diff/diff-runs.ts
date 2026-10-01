import { EVAL_RUN_SCHEMA_ID, evalRunSchema } from '@attest/contracts';
import type { RunRecord, RunStore } from '../store/types.js';
import { canonicalStringify } from '../store/internal/canonical-json.js';
import { classifyRuns } from './classify.js';
import type { RunDiff } from './types.js';

/** Reads selection metadata at the persisted JSON boundary, including older filtered evals. */
const evalScope = (run: RunRecord): { partial: boolean; tests: string[] } | undefined => {
  if (run.schemaId !== EVAL_RUN_SCHEMA_ID) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(run.configJson);
  } catch {
    return undefined;
  }
  const parsed = evalRunSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const {
    snapshot,
    effective_command: { request },
  } = parsed.data;
  return {
    partial:
      snapshot.selection === undefined
        ? request.case_ids !== undefined || request.tags !== undefined
        : snapshot.selection.selected_cases < snapshot.selection.total_cases,
    tests: [...snapshot.selected_test_ids].sort(),
  };
};

/** Loads two runs and delegates their cases to the pure classifier. */
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
    JSON.stringify(baseScope.tests) !== JSON.stringify(candidateScope.tests);
  return classifyRuns(base.cases, candidate.cases, {
    baseRunId,
    candidateRunId,
    baseConfigHash: base.run.configHash,
    candidateConfigHash: candidate.run.configHash,
    sharedOnly: baseScope?.partial === true || candidateScope?.partial === true || differentTests,
  });
};

/** Serializes a diff with recursively stable object-key ordering. */
const diffToJson = (diff: RunDiff): string => canonicalStringify(diff);

export { diffRuns, diffToJson };
