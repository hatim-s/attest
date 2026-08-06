import type { CaseRecord, StoredMetricEvaluation } from '../store/types.js';
import type {
  CaseTransition,
  CaseTransitionKind,
  CaseVerdict,
  MetricDelta,
  RunDiff,
} from './types.js';

/** Float-noise tolerance: 1e-9 dwarfs f64 ULPs at score scale but not meaningful score deltas. */
const SCORE_EQUALITY_EPSILON = 1e-9;

const transitionKinds = [
  'added',
  'removed',
  'fixed',
  'regressed',
  'still_passing',
  'still_failing',
] as const satisfies readonly CaseTransitionKind[];

type ArrayWithToSorted<Value> = Value[] & {
  toSorted(compareFunction?: (left: Value, right: Value) => number): Value[];
};

/** Uses Bun's immutable sort while the repository's TypeScript lib target catches up. */
const immutableSort = <Value>(
  values: Value[],
  compareFunction?: (left: Value, right: Value) => number,
): Value[] => (values as ArrayWithToSorted<Value>).toSorted(compareFunction);

/** Computes the exclusive case verdict defined by PLAN 1D.1. */
const computeCaseVerdict = (caseRecord: CaseRecord): CaseVerdict => {
  if (caseRecord.outcome !== 'completed') {
    return 'error';
  }

  // mirrors store/internal/run-summary.ts — gate reconciliation owns unification
  const metricsByExpectedName = metricsByName(caseRecord);
  let failed = false;
  for (const metricName of caseRecord.expectedMetrics) {
    const metric = metricsByExpectedName.get(metricName);
    if (!metric || metric.status !== 'evaluated' || metric.pass === undefined) {
      return 'error';
    }
    failed ||= metric.pass !== true;
  }
  return failed ? 'fail' : 'pass';
};

const metricsByName = (caseRecord: CaseRecord | undefined): Map<string, StoredMetricEvaluation> =>
  new Map(caseRecord?.metrics.map((metric) => [metric.metricName, metric]) ?? []);

/** Verifies equal metric names and indistinguishable numeric scores where both sides provide them. */
const hasIdenticalMetricScores = (base: CaseRecord, candidate: CaseRecord): boolean => {
  const candidateMetrics = metricsByName(candidate);
  const baseMetricNames = new Set(base.metrics.map((metric) => metric.metricName));
  const candidateMetricNames = new Set(candidate.metrics.map((metric) => metric.metricName));
  if (
    baseMetricNames.size !== candidateMetricNames.size ||
    [...baseMetricNames].some((metricName) => !candidateMetricNames.has(metricName))
  ) {
    return false;
  }

  let sharedNumericScoreCount = 0;
  for (const baseMetric of base.metrics) {
    const candidateMetric = candidateMetrics.get(baseMetric.metricName);
    if (!candidateMetric) {
      return false;
    }

    if (typeof baseMetric.score !== 'number' || typeof candidateMetric.score !== 'number') {
      continue;
    }
    if (!Number.isFinite(baseMetric.score) || !Number.isFinite(candidateMetric.score)) {
      return false;
    }
    sharedNumericScoreCount += 1;
    if (Math.abs(candidateMetric.score - baseMetric.score) >= SCORE_EQUALITY_EPSILON) {
      return false;
    }
  }

  return sharedNumericScoreCount > 0;
};

/**
 * Classifies a case pair using PLAN 1D.1 transition semantics.
 * Primary verdict transitions remain independent from flakiness annotations.
 */
const classifyTransition = (
  base: CaseRecord | undefined,
  candidate: CaseRecord | undefined,
): CaseTransitionKind => {
  if (!base) {
    return 'added';
  }
  if (!candidate) {
    return 'removed';
  }

  const baseVerdict = computeCaseVerdict(base);
  const candidateVerdict = computeCaseVerdict(candidate);
  if (baseVerdict === 'pass' && candidateVerdict === 'pass') {
    return 'still_passing';
  }
  if (baseVerdict !== 'pass' && candidateVerdict === 'pass') {
    return 'fixed';
  }
  if (baseVerdict === 'pass' && candidateVerdict !== 'pass') {
    return 'regressed';
  }

  return 'still_failing';
};

const computePassTransition = (
  base: StoredMetricEvaluation | undefined,
  candidate: StoredMetricEvaluation | undefined,
): MetricDelta['passTransition'] => {
  if (base?.pass === true && candidate?.pass !== true) {
    return 'lost';
  }
  if (base?.pass !== true && candidate?.pass === true) {
    return 'gained';
  }

  return 'unchanged';
};

/** Computes name-ordered metric score and pass movement for PLAN 1D.1. */
const computeMetricDeltas = (
  base: CaseRecord | undefined,
  candidate: CaseRecord | undefined,
): MetricDelta[] => {
  const baseMetrics = metricsByName(base);
  const candidateMetrics = metricsByName(candidate);
  const metricNames = immutableSort([
    ...new Set([...baseMetrics.keys(), ...candidateMetrics.keys()]),
  ]);
  return metricNames.map((metricName) => {
    const baseMetric = baseMetrics.get(metricName);
    const candidateMetric = candidateMetrics.get(metricName);
    const metricDelta: MetricDelta = {
      metricName,
      baseScore: baseMetric?.score,
      candidateScore: candidateMetric?.score,
      passTransition: computePassTransition(baseMetric, candidateMetric),
    };
    if (baseMetric?.score !== undefined && candidateMetric?.score !== undefined) {
      metricDelta.delta = candidateMetric.score - baseMetric.score;
    }
    return metricDelta;
  });
};

const indexCases = (cases: CaseRecord[]): Map<string, Map<string, CaseRecord>> => {
  const suites = new Map<string, Map<string, CaseRecord>>();
  for (const caseRecord of cases) {
    const suite = suites.get(caseRecord.suiteName) ?? new Map<string, CaseRecord>();
    suite.set(caseRecord.caseId, caseRecord);
    suites.set(caseRecord.suiteName, suite);
  }
  return suites;
};

const countPasses = (cases: CaseRecord[]): number =>
  cases.filter((caseRecord) => computeCaseVerdict(caseRecord) === 'pass').length;

/** Determines whether a verdict transition has sufficient identical evidence to flag flakiness. */
const isFlakinessSuspected = (
  base: CaseRecord | undefined,
  candidate: CaseRecord | undefined,
  configHashes: { baseConfigHash: string; candidateConfigHash: string },
): boolean => {
  if (!base || !candidate) {
    return false;
  }
  const baseVerdict = computeCaseVerdict(base);
  const candidateVerdict = computeCaseVerdict(candidate);
  return (
    configHashes.baseConfigHash === configHashes.candidateConfigHash &&
    base.inputHash === candidate.inputHash &&
    (baseVerdict === 'pass' || baseVerdict === 'fail') &&
    (candidateVerdict === 'pass' || candidateVerdict === 'fail') &&
    baseVerdict !== candidateVerdict &&
    hasIdenticalMetricScores(base, candidate)
  );
};

/** Classifies two case collections in stable suite-and-case order (PLAN 1D.1). */
const classifyRuns = (
  baseCases: CaseRecord[],
  candidateCases: CaseRecord[],
  comparison: {
    baseRunId: string;
    candidateRunId: string;
    baseConfigHash: string;
    candidateConfigHash: string;
  },
): RunDiff => {
  const baseIndex = indexCases(baseCases);
  const candidateIndex = indexCases(candidateCases);
  const suiteNames = immutableSort([...new Set([...baseIndex.keys(), ...candidateIndex.keys()])]);
  const transitions: CaseTransition[] = [];
  for (const suiteName of suiteNames) {
    const baseSuite = baseIndex.get(suiteName);
    const candidateSuite = candidateIndex.get(suiteName);
    const caseIds = immutableSort([
      ...new Set([...(baseSuite?.keys() ?? []), ...(candidateSuite?.keys() ?? [])]),
    ]);
    for (const caseId of caseIds) {
      const base = baseSuite?.get(caseId);
      const candidate = candidateSuite?.get(caseId);
      const flakiness = isFlakinessSuspected(base, candidate, comparison) ? 'suspected' : undefined;
      transitions.push({
        suiteName,
        caseId,
        kind: classifyTransition(base, candidate),
        baseVerdict: base ? computeCaseVerdict(base) : undefined,
        candidateVerdict: candidate ? computeCaseVerdict(candidate) : undefined,
        metricDeltas: computeMetricDeltas(base, candidate),
        flakiness,
      });
    }
  }

  const counts = Object.fromEntries(transitionKinds.map((kind) => [kind, 0])) as Record<
    CaseTransitionKind,
    number
  >;
  for (const transition of transitions) {
    counts[transition.kind] += 1;
  }

  return {
    summary: {
      baseRunId: comparison.baseRunId,
      candidateRunId: comparison.candidateRunId,
      baseConfigHash: comparison.baseConfigHash,
      candidateConfigHash: comparison.candidateConfigHash,
      counts,
      flakySuspectCount: transitions.filter((transition) => transition.flakiness === 'suspected')
        .length,
      basePassRate: baseCases.length === 0 ? 0 : countPasses(baseCases) / baseCases.length,
      candidatePassRate:
        candidateCases.length === 0 ? 0 : countPasses(candidateCases) / candidateCases.length,
    },
    transitions,
  };
};

export {
  SCORE_EQUALITY_EPSILON,
  classifyRuns,
  classifyTransition,
  computeCaseVerdict,
  computeMetricDeltas,
};
