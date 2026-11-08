import type { EvalSlice } from '@attest/core/records';

type RunDestination = { kind: 'eval'; suiteName: string } | { kind: 'evals' };

/**
 * Where a project-level run link lands. A run with exactly one eval opens that eval's run page;
 * a run with several, or none recorded yet, lists its evals instead of picking one.
 */
const runDestination = (suites: readonly EvalSlice[]): RunDestination => {
  const [only, ...rest] = suites;

  return only !== undefined && rest.length === 0
    ? { kind: 'eval', suiteName: only.suiteName }
    : { kind: 'evals' };
};

export { runDestination, type RunDestination };
