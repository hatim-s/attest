import { AGENT_PROTOCOL, type AgentRequest } from '@attest/contracts';
import { describe, expect, it } from 'vitest';

import type { CaseRecord, StoredMetricEvaluation } from '../store/types.js';
import {
  classifyRuns,
  classifyTransition,
  computeCaseVerdict,
  computeMetricDeltas,
} from './classify.js';
import type { CaseTransitionKind, CaseVerdict } from './types.js';

type ClassifiedCase = CaseRecord;

const comparison = {
  baseRunId: 'base',
  candidateRunId: 'candidate',
  baseConfigHash: 'config',
  candidateConfigHash: 'config',
};

const request: AgentRequest = {
  protocol: AGENT_PROTOCOL,
  run_id: 'run',
  case_id: 'case',
  input: {},
  params: {},
};

const caseRecord = (
  verdict: CaseVerdict,
  options: { suiteName?: string; caseId?: string; score?: number; inputHash?: string } = {},
): ClassifiedCase => {
  const metric: StoredMetricEvaluation = {
    metricName: 'quality',
    kind: 'assertion',
    status: verdict === 'error' ? 'error' : 'evaluated',
    score: options.score ?? (verdict === 'pass' ? 1 : verdict === 'fail' ? 0 : -1),
    pass: verdict === 'pass',
    error: verdict === 'error' ? { kind: 'test', message: 'metric failed' } : undefined,
  };
  const shared = {
    rowId: `${options.suiteName ?? 'suite'}:${options.caseId ?? 'case'}`,
    runId: 'run',
    suiteName: options.suiteName ?? 'suite',
    caseId: options.caseId ?? 'case',
    outcome: verdict === 'error' ? 'timeout' : 'completed',
    startedAt: '2026-08-06T00:00:00.000Z',
    durationMs: 1,
    request,
    warnings: [],
    diagnostics: {},
    attempts: [],
    expectedMetrics: ['quality'],
    metrics: [metric],
  };
  const inputHash = options.inputHash ?? 'default-input';
  return verdict === 'error'
    ? {
        ...shared,
        inputHash,
        outcome: 'timeout' as const,
        errorCode: 'timeout' as const,
        errorMessage: 'invocation failed',
      }
    : { ...shared, inputHash, outcome: 'completed' as const, response: {} };
};

/** Public verdict-pair contract: changes here must force the seeded oracle to fail. */
const verdictPairTransitions: Record<CaseVerdict, Record<CaseVerdict, CaseTransitionKind>> = {
  pass: { pass: 'still_passing', fail: 'regressed', error: 'regressed' },
  fail: { pass: 'fixed', fail: 'still_failing', error: 'still_failing' },
  error: { pass: 'fixed', fail: 'still_failing', error: 'still_failing' },
};

describe('computeCaseVerdict', () => {
  it('requires a completed invocation and every metric to be evaluated and passing', () => {
    expect(computeCaseVerdict(caseRecord('pass'))).toBe('pass');
    expect(computeCaseVerdict(caseRecord('fail'))).toBe('fail');
    expect(computeCaseVerdict(caseRecord('error'))).toBe('error');
  });
});

describe('classifyTransition', () => {
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
    expect(classifyTransition(caseRecord(baseVerdict), caseRecord(candidateVerdict))).toBe(
      expected,
    );
  });

  it('classifies presence changes', () => {
    expect(classifyTransition(undefined, caseRecord('pass'))).toBe('added');
    expect(classifyTransition(caseRecord('pass'), undefined)).toBe('removed');
  });
});

describe('computeMetricDeltas', () => {
  it('returns the metric-name union in name order', () => {
    const base = caseRecord('pass');
    base.metrics = [
      { metricName: 'zeta', kind: 'assertion', status: 'evaluated', score: 0.8, pass: true },
    ];
    const candidate = caseRecord('pass');
    candidate.metrics = [
      { metricName: 'alpha', kind: 'assertion', status: 'evaluated', score: 0.4, pass: false },
      { metricName: 'zeta', kind: 'assertion', status: 'evaluated', score: 0.9, pass: true },
    ];

    const deltas = computeMetricDeltas(base, candidate);
    expect(deltas).toMatchObject([
      {
        metricName: 'alpha',
        baseScore: undefined,
        candidateScore: 0.4,
        passTransition: 'unchanged',
      },
      {
        metricName: 'zeta',
        baseScore: 0.8,
        candidateScore: 0.9,
        passTransition: 'unchanged',
      },
    ]);
    expect(deltas[1]!.delta).toBeCloseTo(0.1);
  });
});

describe('classifyRuns', () => {
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

  it('matches an independent oracle over seeded random inputs', () => {
    let seed = 0x5eed1234;
    const random = (): number => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };

    for (let iteration = 0; iteration < 200; iteration += 1) {
      const createCases = (): ClassifiedCase[] =>
        Array.from({ length: Math.floor(random() * 12) }, (_, index) =>
          caseRecord(['pass', 'fail', 'error'][Math.floor(random() * 3)] as CaseVerdict, {
            suiteName: `suite-${Math.floor(random() * 3)}`,
            caseId: `case-${index}`,
            score: Math.floor(random() * 4) / 4,
          }),
        );
      const baseCases = createCases();
      const candidateCases = createCases();
      const diff = classifyRuns(baseCases, candidateCases, comparison);
      const expectedKinds = diff.transitions.map((transition) => {
        const matches = (caseToFind: CaseRecord): boolean =>
          caseToFind.suiteName === transition.suiteName && caseToFind.caseId === transition.caseId;
        const baseCase = [...baseCases].reverse().find(matches);
        const candidateCase = [...candidateCases].reverse().find(matches);
        if (!baseCase) return 'added';
        if (!candidateCase) return 'removed';
        return verdictPairTransitions[computeCaseVerdict(baseCase)][
          computeCaseVerdict(candidateCase)
        ];
      });

      expect(diff.transitions.map((transition) => transition.kind)).toEqual(expectedKinds);
    }
  });

  it.each([
    [
      'config hash mismatch',
      { ...comparison, candidateConfigHash: 'other' },
      'pass',
      'fail',
      false,
    ],
    ['error verdict', comparison, 'pass', 'error', false],
  ] as const)(
    '%s never marks incomparable transitions flaky',
    (_, hashes, baseVerdict, candidateVerdict, expected) => {
      const diff = classifyRuns(
        [caseRecord(baseVerdict, { score: 0.5, inputHash: 'input' })],
        [caseRecord(candidateVerdict, { score: 0.5, inputHash: 'input' })],
        hashes,
      );
      expect(diff.transitions[0]!.flakiness === 'suspected').toBe(expected);
    },
  );

  it('does not annotate one-sided metrics, but annotates comparable fixed and regressed verdicts', () => {
    const base = caseRecord('pass', { score: 0.5, inputHash: 'input' });
    const candidate = caseRecord('fail', { score: 0.5, inputHash: 'input' });
    expect(classifyRuns([base], [candidate], comparison).transitions[0]).toMatchObject({
      kind: 'regressed',
      flakiness: 'suspected',
    });
    candidate.metrics.push({
      metricName: 'safety',
      kind: 'assertion',
      status: 'evaluated',
      pass: false,
    });
    expect(classifyRuns([base], [candidate], comparison).transitions[0]).toMatchObject({
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
});
