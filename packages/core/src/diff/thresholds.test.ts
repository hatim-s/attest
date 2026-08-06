import { AGENT_PROTOCOL, type AgentRequest } from '@attest/contracts';
import { describe, expect, it } from 'vitest';

import type { CaseRecord } from '../store/types.js';
import { DiffConfigError, evaluateThresholds } from './thresholds.js';
import type { RunDiff } from './types.js';

const request: AgentRequest = {
  protocol: AGENT_PROTOCOL,
  run_id: 'candidate',
  case_id: 'case',
  input: {},
  params: {},
};
const counts = {
  added: 0,
  removed: 0,
  fixed: 0,
  regressed: 2,
  still_passing: 0,
  still_failing: 0,
};
const diff: RunDiff = {
  summary: {
    baseRunId: 'base',
    candidateRunId: 'candidate',
    baseConfigHash: 'base-config',
    candidateConfigHash: 'candidate-config',
    counts,
    flakySuspectCount: 0,
    basePassRate: 0.95,
    candidatePassRate: 0.82,
  },
  transitions: [
    {
      suiteName: 'suite',
      caseId: 'first',
      kind: 'regressed',
      baseVerdict: 'pass',
      candidateVerdict: 'fail',
      metricDeltas: [],
    },
    {
      suiteName: 'suite',
      caseId: 'second',
      kind: 'regressed',
      baseVerdict: 'pass',
      candidateVerdict: 'fail',
      metricDeltas: [],
    },
  ],
};
const makeCaseRecord = (overrides: Partial<CaseRecord> = {}): CaseRecord => {
  const { outcome = 'timeout', ...rest } = overrides;
  const shared = {
    rowId: 'row',
    runId: 'candidate',
    suiteName: 'suite',
    caseId: 'case',
    startedAt: '2026-08-06T00:00:00.000Z',
    durationMs: 1,
    request,
    warnings: [],
    diagnostics: {},
    attempts: [],
    expectedMetrics: [],
    metrics: [
      {
        metricName: 'quality',
        kind: 'judge' as const,
        status: 'error' as const,
        error: { kind: 'timeout', message: 'judge timeout' },
      },
    ],
  };
  return outcome === 'completed'
    ? ({ ...shared, ...rest, outcome, response: {} } as CaseRecord)
    : ({
        ...shared,
        outcome,
        errorCode: 'timeout',
        errorMessage: 'invocation failed',
        ...rest,
      } as CaseRecord);
};

const candidate = makeCaseRecord();

describe('evaluateThresholds', () => {
  it('enforces no rules by default', () => {
    expect(evaluateThresholds(diff, [candidate], {})).toEqual({
      pass: true,
      exitCode: 0,
      reasons: [],
    });
  });

  it('reports every violated configured rule with actionable text', () => {
    expect(
      evaluateThresholds(diff, [candidate], {
        minPassRate: 0.9,
        maxRegressions: 1,
        failOnInvocationErrors: true,
        failOnMetricErrors: true,
      }),
    ).toEqual({
      pass: false,
      exitCode: 1,
      reasons: [
        'pass rate 0.82 below minimum 0.9',
        '2 base-pass to candidate-nonpass transitions exceed maximum 1',
        '1 invocation errors in candidate run',
        '1 metric errors in candidate run',
      ],
    });
  });

  it('passes when every configured boundary is satisfied', () => {
    const cleanCandidate = makeCaseRecord({
      outcome: 'completed',
      response: {},
      metrics: [
        {
          metricName: 'quality',
          kind: 'judge',
          status: 'evaluated',
          pass: true,
        },
      ],
    });
    expect(
      evaluateThresholds(diff, [cleanCandidate], {
        minPassRate: 0.82,
        maxRegressions: 2,
        failOnInvocationErrors: true,
        failOnMetricErrors: true,
      }),
    ).toEqual({ pass: true, exitCode: 0, reasons: [] });
  });

  it.each([
    ['minPassRate', Number.NaN],
    ['minPassRate', Number.POSITIVE_INFINITY],
    ['minPassRate', -0.01],
    ['minPassRate', 1.01],
    ['maxRegressions', Number.NaN],
    ['maxRegressions', Number.POSITIVE_INFINITY],
    ['maxRegressions', -1],
    ['maxRegressions', 0.5],
  ] as const)('rejects invalid %s values', (key, value) => {
    expect(() => evaluateThresholds(diff, [], { [key]: value })).toThrow(DiffConfigError);
    expect(() => evaluateThresholds(diff, [], { [key]: value })).toThrow(String(value));
  });

  it('counts pass-to-error and flaky-annotated pass-to-fail transitions for maxRegressions', () => {
    const gatedDiff: RunDiff = {
      ...diff,
      transitions: [
        {
          suiteName: 'suite',
          caseId: 'error',
          kind: 'regressed',
          baseVerdict: 'pass',
          candidateVerdict: 'error',
          metricDeltas: [],
        },
        {
          suiteName: 'suite',
          caseId: 'flaky',
          kind: 'regressed',
          flakiness: 'suspected',
          baseVerdict: 'pass',
          candidateVerdict: 'fail',
          metricDeltas: [],
        },
      ],
    };
    expect(evaluateThresholds(gatedDiff, [], { maxRegressions: 0 })).toEqual({
      pass: false,
      exitCode: 1,
      reasons: ['2 base-pass to candidate-nonpass transitions exceed maximum 0'],
    });
  });
});
