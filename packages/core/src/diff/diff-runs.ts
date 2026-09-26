import { EVAL_RUN_SCHEMA_ID, evalRunSchema } from '@attest/contracts';
import type { RunRecord } from '../store/types.js';
import type { RunStore } from '../store/types.js';
import { canonicalStringify } from '../store/internal/canonical-json.js';
import { classifyRuns } from './classify.js';
import type { RunDiff } from './types.js';

/** Reads selection metadata at the persisted JSON boundary, including older filtered evals. */
const isPartialEval = (run: RunRecord): boolean => {
  if (run.schemaId !== EVAL_RUN_SCHEMA_ID) return false;
  let value: unknown;
  try {
    value = JSON.parse(run.configJson);
  } catch {
    return false;
  }
  const parsed = evalRunSchema.safeParse(value);
  if (!parsed.success) return false;
  const {
    snapshot,
    effective_command: { request },
  } = parsed.data;
  if (snapshot.selection !== undefined)
    return snapshot.selection.selected_cases < snapshot.selection.total_cases;
  return request.case_ids !== undefined || request.tags !== undefined;
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
  return classifyRuns(base.cases, candidate.cases, {
    baseRunId,
    candidateRunId,
    baseConfigHash: base.run.configHash,
    candidateConfigHash: candidate.run.configHash,
    sharedOnly: isPartialEval(base.run) || isPartialEval(candidate.run),
  });
};

/** Serializes a diff with recursively stable object-key ordering. */
const diffToJson = (diff: RunDiff): string => canonicalStringify(diff);

export { diffRuns, diffToJson };
