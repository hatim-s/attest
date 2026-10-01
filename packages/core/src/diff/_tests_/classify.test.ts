import { AGENT_PROTOCOL } from '@attest/contracts';
import { describe, expect, it } from 'vitest';

import type { CaseRecord, CaseVerdict, StoredMetricEvaluation } from '../../store/types.js';
import { classifyRuns } from '../classify.js';
import type { CaseTransitionKind } from '../types.js';

const comparison = {
  baseRunId: 'base',
  candidateRunId: 'candidate',
  baseConfigHash: 'config',
  candidateConfigHash: 'config',
};

interface CaseOptions {
  suiteName?: string;
  caseId?: string;
  score?: number;
  inputHash?: string;
}

const qualityMetric = (verdict: CaseVerdict, score: number | undefined): StoredMetricEvaluation => {
  if (verdict === 'error') {
    return {
      metricName: 'quality',
      kind: 'assertion',
      status: 'error',
      error: { kind: 'test', message: 'metric failed' },
    };
  }
  return {
    metricName: 'quality',
    kind: 'assertion',
    status: 'evaluated',
    score: score ?? (verdict === 'pass' ? 1 : 0),
    pass: verdict === 'pass',
  };
};

const caseRecord = (verdict: CaseVerdict, options: CaseOptions = {}): CaseRecord => {
  const suiteName = options.suiteName ?? 'suite';
  const caseId = options.caseId ?? 'case';
  const shared = {
    rowId: `${suiteName}:${caseId}`,
    runId: 'run',
    suiteName,
    caseId,
    inputHash: options.inputHash ?? 'default-input',
    startedAt: '2026-08-06T00:00:00.000Z',
    durationMs: 1,
    request: { protocol: AGENT_PROTOCOL, run_id: 'run', case_id: caseId, input: {}, params: {} },
    warnings: [],
    diagnostics: {},
    attempts: [],
    expectedMetrics: ['quality'],
    metrics: [qualityMetric(verdict, options.score)],
  };
  if (verdict === 'error') {
    return {
      ...shared,
      outcome: 'timeout',
      errorCode: 'timeout',
      errorMessage: 'invocation failed',
    };
  }
  return { ...shared, outcome: 'completed', response: {} };
};

const classifyPair = (base?: CaseRecord, candidate?: CaseRecord) =>
  classifyRuns(base ? [base] : [], candidate ? [candidate] : [], comparison).transitions[0]!;

describe('classifyRuns', () => {
  const matrix: Array<[CaseVerdict, CaseVerdict, CaseTransitionKind]> = [
    ['pass', 'pass', 'still_passing'],
    ['pass', 'fail', 'regressed'],
    ['pass', 'error', 'regressed'],
    ['fail', 'pass', 'fixed'],
    ['fail', 'fail', 'still_failing'],
    ['fail', 'error', 'still_failing'],
    ['error', 'pass', 'fixed'],
    ['error', 'fail', 'still_failing'],
    ['error', 'error', 'still_failing'],
  ];

  it.each(matrix)('classifies %s to %s as %s', (baseVerdict, candidateVerdict, expected) => {
    expect(classifyPair(caseRecord(baseVerdict), caseRecord(candidateVerdict)).kind).toBe(expected);
  });

  it('classifies presence changes', () => {
    expect(classifyPair(undefined, caseRecord('pass')).kind).toBe('added');
    expect(classifyPair(caseRecord('pass'), undefined).kind).toBe('removed');
  });

  it('returns metric deltas over the metric-name union in name order', () => {
    const base = caseRecord('pass');
    base.metrics = [
      { metricName: 'zeta', kind: 'assertion', status: 'evaluated', score: 0.8, pass: true },
    ];
    const candidate = caseRecord('pass');
    candidate.metrics = [
      { metricName: 'alpha', kind: 'assertion', status: 'evaluated', score: 0.4, pass: false },
      { metricName: 'zeta', kind: 'assertion', status: 'evaluated', score: 0.9, pass: true },
    ];

    const { metricDeltas } = classifyPair(base, candidate);
    expect(metricDeltas).toMatchObject([
      {
        metricName: 'alpha',
        baseScore: undefined,
        candidateScore: 0.4,
        passTransition: 'unchanged',
      },
      { metricName: 'zeta', baseScore: 0.8, candidateScore: 0.9, passTransition: 'unchanged' },
    ]);
    expect(metricDeltas[1]!.delta).toBeCloseTo(0.1);
  });

  it('orders transitions by suite name and then case id', () => {
    const diff = classifyRuns(
      [
        caseRecord('pass', { suiteName: 'zeta', caseId: 'two' }),
        caseRecord('pass', { suiteName: 'alpha', caseId: 'three' }),
      ],
      [
        caseRecord('pass', { suiteName: 'alpha', caseId: 'one' }),
        caseRecord('pass', { suiteName: 'zeta', caseId: 'one' }),
      ],
      comparison,
    );

    expect(diff.transitions.map(({ suiteName, caseId }) => [suiteName, caseId])).toEqual([
      ['alpha', 'one'],
      ['alpha', 'three'],
      ['zeta', 'one'],
      ['zeta', 'two'],
    ]);
  });

  it.each([
    ['config hash mismatch', { ...comparison, candidateConfigHash: 'other' }, 'pass', 'fail'],
    ['error verdict', comparison, 'pass', 'error'],
  ] as const)(
    '%s never marks incomparable transitions flaky',
    (_, hashes, baseVerdict, candidateVerdict) => {
      const diff = classifyRuns(
        [caseRecord(baseVerdict, { score: 0.5, inputHash: 'input' })],
        [caseRecord(candidateVerdict, { score: 0.5, inputHash: 'input' })],
        hashes,
      );
      expect(diff.transitions[0]!.flakiness).toBeUndefined();
    },
  );

  it('does not annotate one-sided metrics, but annotates comparable fixed and regressed verdicts', () => {
    const base = caseRecord('pass', { score: 0.5, inputHash: 'input' });
    const candidate = caseRecord('fail', { score: 0.5, inputHash: 'input' });
    expect(classifyPair(base, candidate)).toMatchObject({
      kind: 'regressed',
      flakiness: 'suspected',
    });
    candidate.metrics.push({
      metricName: 'safety',
      kind: 'assertion',
      status: 'evaluated',
      score: 0,
      pass: false,
    });
    expect(classifyPair(base, candidate)).toMatchObject({
      kind: 'regressed',
      flakiness: undefined,
    });
    const fixed = classifyRuns(
      [caseRecord('fail', { score: 0.5, inputHash: 'input' })],
      [caseRecord('pass', { score: 0.5, inputHash: 'input' })],
      comparison,
    );
    expect(fixed.transitions[0]).toMatchObject({ kind: 'fixed', flakiness: 'suspected' });
    expect(fixed.summary.flakySuspectCount).toBe(1);
  });

  it('compares shared identities in partial runs and reports unmatched coverage', () => {
    const base = [
      caseRecord('pass', { caseId: 'shared' }),
      caseRecord('fail', { caseId: 'excluded' }),
    ];
    const candidate = [
      caseRecord('fail', { caseId: 'shared' }),
      caseRecord('pass', { caseId: 'new-sample' }),
    ];
    const result = classifyRuns(base, candidate, { ...comparison, sharedOnly: true });
    expect(result.transitions.map(({ kind }) => kind)).toEqual(['regressed']);
    expect(result.summary).toMatchObject({
      basePassRate: 1,
      candidatePassRate: 0,
      coverage: { sharedCases: 1, baseOnlyCases: 1, candidateOnlyCases: 1 },
    });
    expect(result.summary.counts.removed).toBe(0);
    expect(result.summary.counts.added).toBe(0);
  });
});
