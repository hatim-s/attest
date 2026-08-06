type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
type CaseVerdict = 'pass' | 'fail' | 'error';

type RunSummary = {
  totalCases: number;
  passedCases: number;
  failedCases: number;
  errorCases: number;
  metricErrorCount: number;
};

type RunRecord = {
  id: string;
  configVersion: string;
  configHash: string;
  configJson: string;
  createdAt: string;
  finishedAt?: string;
  gitSha?: string;
  gitBranch?: string;
  labels?: Record<string, string>;
  status: RunStatus;
  summary?: RunSummary;
};

type CaseSummary = {
  caseId: string;
  suiteName: string;
  outcome: string;
  verdict: CaseVerdict;
  startedAt: string;
  durationMs: number;
  metricCounts: { expected: number; evaluated: number; passed: number; errors: number };
};

type StoredMetricEvaluation = {
  metricName: string;
  kind: 'assertion' | 'exec' | 'judge';
  status: 'evaluated' | 'error';
  score?: number;
  pass?: boolean;
  rationale?: string;
  details?: unknown;
  error?: { message: string; kind: string };
  durationMs?: number;
};

type CaseRecord = {
  attempts: unknown[];
  caseId: string;
  diagnostics: unknown;
  durationMs: number;
  errorCode?: string;
  errorMessage?: string;
  expectedMetrics: string[];
  inputHash: string;
  metrics: StoredMetricEvaluation[];
  outcome: string;
  request: unknown;
  response?: unknown;
  rowId: string;
  runId: string;
  startedAt: string;
  suiteName: string;
  trace?: unknown;
  warnings: unknown[];
};

type CaseTransitionKind =
  'added' | 'removed' | 'fixed' | 'regressed' | 'still_passing' | 'still_failing';

type CaseTransition = {
  suiteName: string;
  caseId: string;
  kind: CaseTransitionKind;
  flakiness?: 'suspected';
  baseVerdict?: CaseVerdict;
  candidateVerdict?: CaseVerdict;
  metricDeltas: Array<{
    metricName: string;
    baseScore?: number;
    candidateScore?: number;
    delta?: number;
    passTransition: 'unchanged' | 'gained' | 'lost';
  }>;
};

type RunDiff = {
  summary: {
    baseRunId: string;
    candidateRunId: string;
    baseConfigHash: string;
    candidateConfigHash: string;
    counts: Record<CaseTransitionKind, number>;
    flakySuspectCount: number;
    basePassRate: number;
    candidatePassRate: number;
  };
  transitions: CaseTransition[];
};

export {
  type CaseRecord,
  type CaseSummary,
  type CaseTransition,
  type CaseTransitionKind,
  type CaseVerdict,
  type RunDiff,
  type RunRecord,
  type RunStatus,
  type RunSummary,
  type StoredMetricEvaluation,
};
