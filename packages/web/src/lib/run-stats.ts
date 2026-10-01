import type { RunRecord } from '../api/types.js';

/** Calculates the run pass rate without pretending an empty run is successful. */
const runPassRate = (run: RunRecord): number | undefined => {
  if (run.summary === undefined || run.summary.totalCases === 0) return undefined;
  return run.summary.passedCases / run.summary.totalCases;
};

export { runPassRate };
