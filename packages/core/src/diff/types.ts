/** Case-level verdict derived from invocation and metric outcomes (PLAN 1D.1). */
type CaseVerdict = 'pass' | 'fail' | 'error';

/** Exhaustive transition classification for a case across two runs (PLAN 1D.1). */
type CaseTransitionKind =
  'added' | 'removed' | 'fixed' | 'regressed' | 'still_passing' | 'still_failing';

/** Describes score and pass movement for one metric (PLAN 1D.1). */
interface MetricDelta {
  metricName: string;
  baseScore?: number;
  candidateScore?: number;
  delta?: number;
  passTransition: 'unchanged' | 'gained' | 'lost';
}

/** Describes one case's presence, verdict, and metric changes (PLAN 1D.1). */
interface CaseTransition {
  suiteName: string;
  caseId: string;
  kind: CaseTransitionKind;
  /** Marks a comparable pass/fail verdict flip whose metric scores are indistinguishable. */
  flakiness?: 'suspected';
  baseVerdict?: CaseVerdict;
  candidateVerdict?: CaseVerdict;
  metricDeltas: MetricDelta[];
}

/** Aggregates deterministic case transition and pass-rate totals (PLAN 1D.1). */
interface DiffSummary {
  baseRunId: string;
  candidateRunId: string;
  baseConfigHash: string;
  candidateConfigHash: string;
  counts: Record<CaseTransitionKind, number>;
  flakySuspectCount: number;
  basePassRate: number;
  candidatePassRate: number;
}

/** Represents the complete comparison between two persisted runs (PLAN 1D.1). */
interface RunDiff {
  summary: DiffSummary;
  transitions: CaseTransition[];
}

/** Configures optional CI failure gates over a run diff (PLAN 1D.3). */
interface ThresholdConfig {
  minPassRate?: number;
  maxRegressions?: number;
  failOnInvocationErrors?: boolean;
  failOnMetricErrors?: boolean;
}

/** Reports the CI-compatible decision and human-actionable failures (PLAN 1D.3). */
interface CiVerdict {
  pass: boolean;
  exitCode: 0 | 1;
  reasons: string[];
}

export {
  type CaseTransition,
  type CaseTransitionKind,
  type CaseVerdict,
  type CiVerdict,
  type DiffSummary,
  type MetricDelta,
  type RunDiff,
  type ThresholdConfig,
};
