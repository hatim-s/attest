import type { RunStore } from '../store/types.js';
import { canonicalStringify } from '../store/internal/canonical-json.js';
import { classifyRuns } from './classify.js';
import type { RunDiff } from './types.js';

/** Loads two runs and delegates their cases to the pure PLAN 1D.1 classifier. */
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
  return classifyRuns(base.cases, candidate.cases, {
    baseRunId,
    candidateRunId,
    baseConfigHash: base.run.configHash,
    candidateConfigHash: candidate.run.configHash,
  });
};

/** Serializes a diff with recursively stable object-key ordering. */
const diffToJson = (diff: RunDiff): string => canonicalStringify(diff);

export { diffRuns, diffToJson };
