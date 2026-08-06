export {
  classifyRuns,
  classifyTransition,
  computeCaseVerdict,
  computeMetricDeltas,
} from './classify.js';
export { diffRuns, diffToJson } from './diff-runs.js';
export { runToJUnitXml } from './junit-xml.js';
export { DiffConfigError, evaluateThresholds } from './thresholds.js';
export {
  type CaseTransition,
  type CaseTransitionKind,
  type CaseVerdict,
  type CiVerdict,
  type DiffSummary,
  type MetricDelta,
  type RunDiff,
  type ThresholdConfig,
} from './types.js';
