/** Case-level verdict derived from invocation and metric outcomes. */
type CaseVerdict = 'pass' | 'fail' | 'error';

/** Exhaustive transition classification for a case across two runs. */
type CaseTransitionKind =
  'added' | 'removed' | 'fixed' | 'regressed' | 'still_passing' | 'still_failing';

/** Describes score and pass movement for one metric. */
interface MetricDelta {
  metricName: string;
  baseScore?: number;
  candidateScore?: number;
  delta?: number;
  passTransition: 'unchanged' | 'gained' | 'lost';
}

/** Describes one case's presence, verdict, and metric changes. */
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

/** Aggregates deterministic case transition and pass-rate totals. */
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

/** Represents the complete comparison between two persisted runs. */
interface RunDiff {
  summary: DiffSummary;
  transitions: CaseTransition[];
}

/** Configures optional CI failure gates over a run diff. */
interface ThresholdConfig {
  minPassRate?: number;
  maxRegressions?: number;
  failOnInvocationErrors?: boolean;
  failOnMetricErrors?: boolean;
}

/** Reports the CI-compatible decision and human-actionable failures. */
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
