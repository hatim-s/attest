import { computeCaseVerdict } from '../store/case-summary.js';
import type { CaseRecord, CaseVerdict, StoredMetricEvaluation } from '../store/types.js';
import type {
  CaseTransition,
  CaseTransitionKind,
  DiffSummary,
  MetricDelta,
  RunComparison,
  RunDiff,
} from './types.js';

/** Float-noise tolerance: 1e-9 dwarfs f64 ULPs at score scale but not meaningful score deltas. */
const SCORE_EQUALITY_EPSILON = 1e-9;

/** One side of a case pair with its verdict computed once. */
interface JudgedCase {
  record: CaseRecord;
  verdict: CaseVerdict;
}

const judgeCase = (record: CaseRecord | undefined): JudgedCase | undefined =>
  record === undefined ? undefined : { record, verdict: computeCaseVerdict(record) };

const metricsByName = (caseRecord: CaseRecord | undefined): Map<string, StoredMetricEvaluation> =>
  new Map(caseRecord?.metrics.map((metric) => [metric.metricName, metric]) ?? []);

const sortedMetricNames = (caseRecord: CaseRecord): string[] =>
  caseRecord.metrics.map((metric) => metric.metricName).toSorted();

/** Verifies equal metric names and indistinguishable scores where both sides evaluated. */
const hasIdenticalMetricScores = (base: CaseRecord, candidate: CaseRecord): boolean => {
  const baseNames = sortedMetricNames(base);
  const candidateNames = sortedMetricNames(candidate);
  if (baseNames.length !== candidateNames.length) return false;
  if (!baseNames.every((name, index) => name === candidateNames[index])) return false;

  const candidateMetrics = metricsByName(candidate);
  let sharedScoreCount = 0;
  for (const baseMetric of base.metrics) {
    const candidateMetric = candidateMetrics.get(baseMetric.metricName);
    if (baseMetric.status !== 'evaluated' || candidateMetric?.status !== 'evaluated') continue;
    if (Math.abs(candidateMetric.score - baseMetric.score) >= SCORE_EQUALITY_EPSILON) return false;
    sharedScoreCount += 1;
  }
  return sharedScoreCount > 0;
};

/** Primary verdict transitions stay independent from flakiness annotations. */
const classifyTransition = (
  base: JudgedCase | undefined,
  candidate: JudgedCase | undefined,
): CaseTransitionKind => {
  if (!base) return 'added';
  if (!candidate) return 'removed';

  const basePassed = base.verdict === 'pass';
  const candidatePassed = candidate.verdict === 'pass';
  if (basePassed && candidatePassed) return 'still_passing';
  if (candidatePassed) return 'fixed';
  if (basePassed) return 'regressed';
  return 'still_failing';
};

const computePassTransition = (
  base: StoredMetricEvaluation | undefined,
  candidate: StoredMetricEvaluation | undefined,
): MetricDelta['passTransition'] => {
  if (base?.pass === true && candidate?.pass !== true) return 'lost';
  if (base?.pass !== true && candidate?.pass === true) return 'gained';
  return 'unchanged';
};

const computeMetricDeltas = (
  base: CaseRecord | undefined,
  candidate: CaseRecord | undefined,
): MetricDelta[] => {
  const baseMetrics = metricsByName(base);
  const candidateMetrics = metricsByName(candidate);
  const metricNames = [...new Set([...baseMetrics.keys(), ...candidateMetrics.keys()])].toSorted();
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

const isComparableVerdict = (verdict: CaseVerdict): boolean =>
  verdict === 'pass' || verdict === 'fail';

/** Flags a pass/fail flip only when config, input, and metric scores are all indistinguishable. */
const isFlakinessSuspected = (
  base: JudgedCase | undefined,
  candidate: JudgedCase | undefined,
  comparison: RunComparison,
): boolean => {
  if (!base || !candidate) return false;
  return (
    comparison.baseConfigHash === comparison.candidateConfigHash &&
    base.record.inputHash === candidate.record.inputHash &&
    isComparableVerdict(base.verdict) &&
    isComparableVerdict(candidate.verdict) &&
    base.verdict !== candidate.verdict &&
    hasIdenticalMetricScores(base.record, candidate.record)
  );
};

const passRate = (passed: number, total: number): number => (total === 0 ? 0 : passed / total);

/**
 * Classifies two case collections in stable suite-and-case order. With `sharedOnly`, cases
 * present on one side count as coverage differences instead of additions or removals, because
 * partial runs never selected them.
 */
const classifyRuns = (
  baseCases: CaseRecord[],
  candidateCases: CaseRecord[],
  comparison: RunComparison,
): RunDiff => {
  const baseIndex = indexCases(baseCases);
  const candidateIndex = indexCases(candidateCases);
  const suiteNames = [...new Set([...baseIndex.keys(), ...candidateIndex.keys()])].toSorted();
  const transitions: CaseTransition[] = [];
  const counts: Record<CaseTransitionKind, number> = {
    added: 0,
    removed: 0,
    fixed: 0,
    regressed: 0,
    still_passing: 0,
    still_failing: 0,
  };
  const totals = { base: 0, basePassed: 0, candidate: 0, candidatePassed: 0 };
  let baseOnlyCases = 0;
  let candidateOnlyCases = 0;
  let flakySuspectCount = 0;
  for (const suiteName of suiteNames) {
    const baseSuite = baseIndex.get(suiteName);
    const candidateSuite = candidateIndex.get(suiteName);
    const caseIds = [
      ...new Set([...(baseSuite?.keys() ?? []), ...(candidateSuite?.keys() ?? [])]),
    ].toSorted();
    for (const caseId of caseIds) {
      const base = judgeCase(baseSuite?.get(caseId));
      const candidate = judgeCase(candidateSuite?.get(caseId));
      if (!base) candidateOnlyCases += 1;
      if (!candidate) baseOnlyCases += 1;
      if (comparison.sharedOnly === true && (!base || !candidate)) continue;
      if (base) {
        totals.base += 1;
        if (base.verdict === 'pass') totals.basePassed += 1;
      }
      if (candidate) {
        totals.candidate += 1;
        if (candidate.verdict === 'pass') totals.candidatePassed += 1;
      }
      const kind = classifyTransition(base, candidate);
      counts[kind] += 1;
      const flaky = isFlakinessSuspected(base, candidate, comparison);
      if (flaky) flakySuspectCount += 1;
      transitions.push({
        suiteName,
        caseId,
        kind,
        baseVerdict: base?.verdict,
        candidateVerdict: candidate?.verdict,
        metricDeltas: computeMetricDeltas(base?.record, candidate?.record),
        flakiness: flaky ? 'suspected' : undefined,
      });
    }
  }

  const summary: DiffSummary = {
    baseRunId: comparison.baseRunId,
    candidateRunId: comparison.candidateRunId,
    baseConfigHash: comparison.baseConfigHash,
    candidateConfigHash: comparison.candidateConfigHash,
    counts,
    flakySuspectCount,
    basePassRate: passRate(totals.basePassed, totals.base),
    candidatePassRate: passRate(totals.candidatePassed, totals.candidate),
  };
  if (comparison.sharedOnly === true) {
    summary.coverage = { sharedCases: transitions.length, baseOnlyCases, candidateOnlyCases };
  }
  return { summary, transitions };
};

export { classifyRuns };
