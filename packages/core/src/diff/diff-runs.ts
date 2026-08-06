import type { CaseRecord, RunStore } from '../store/types.js';
import { canonicalStringify } from '../store/internal/canonical-json.js';
import { classifyRuns } from './classify.js';
import type { RunDiff } from './types.js';

/** Maps store records to the comparison-only metadata required for flakiness evidence. */
const toClassifiedCase = (caseRecord: CaseRecord): CaseRecord & { inputHash?: string } => {
  return caseRecord as CaseRecord & { inputHash?: string };
};

/** Loads two runs and delegates their cases to the pure PLAN 1D.1 classifier. */
const diffRuns = async (
  store: RunStore,
  baseRunId: string,
  candidateRunId: string,
): Promise<RunDiff> => {
  const [baseRun, candidateRun, baseCases, candidateCases] = await Promise.all([
    store.getRun(baseRunId),
    store.getRun(candidateRunId),
    store.getCaseResults(baseRunId),
    store.getCaseResults(candidateRunId),
  ]);
  return classifyRuns(baseCases.map(toClassifiedCase), candidateCases.map(toClassifiedCase), {
    baseRunId,
    candidateRunId,
    baseConfigHash: baseRun.configHash,
    candidateConfigHash: candidateRun.configHash,
  });
};

/** Serializes a diff with recursively stable object-key ordering. */
const diffToJson = (diff: RunDiff): string => canonicalStringify(diff);

export { diffRuns, diffToJson };
