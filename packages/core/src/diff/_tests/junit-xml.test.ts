import { AGENT_PROTOCOL, type AgentRequest } from '@attest/contracts';
import { describe, expect, it } from 'vitest';

import type { CaseRecord, RunRecord } from '../../store/types.js';
import { classifyRuns } from '../classify.js';
import { diffToJson } from '../diff-runs.js';
import { runToJUnitXml } from '../junit-xml.js';

const comparison = {
  baseRunId: 'base',
  candidateRunId: 'candidate',
  baseConfigHash: 'base-config',
  candidateConfigHash: 'candidate-config',
};

/** Checks the generated element nesting without adding an XML parser dependency. */
const hasBalancedTags = (xml: string): boolean => {
  const openTags: string[] = [];
  for (const tag of xml.matchAll(/<\/?([A-Za-z]+)(?:\s[^>]*)?\/?\s*>/g)) {
    const [wholeTag, name] = tag;
    if (wholeTag.startsWith('</')) {
      if (openTags.pop() !== name) return false;
    } else if (!wholeTag.endsWith('/>') && !wholeTag.startsWith('<?')) {
      openTags.push(name!);
    }
  }
  return openTags.length === 0;
};

const request: AgentRequest = {
  protocol: AGENT_PROTOCOL,
  run_id: 'run<&"',
  case_id: 'case<&"',
  input: {},
  params: {},
};
const run: RunRecord = {
  id: 'run<&"',
  createdAt: '2026-08-06T00:00:00.000Z',
  status: 'failed',
  schemaId: 'attest.project',
  configHash: 'hash',
  configJson: '{}',
};
const makeCaseRecord = (overrides: Partial<CaseRecord> = {}): CaseRecord => {
  const { outcome = 'completed', ...rest } = overrides;
  const shared = {
    rowId: 'row',
    runId: run.id,
    suiteName: 'suite<&"',
    caseId: 'case<&"',
    startedAt: '2026-08-06T00:00:00.000Z',
    durationMs: 250,
    request,
    warnings: [],
    diagnostics: {},
    attempts: [],
    expectedMetrics: [],
    metrics: [],
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

describe('diffToJson', () => {
  it('is byte-identical across equivalent input orderings', () => {
    const first = classifyRuns(
      [makeCaseRecord({ suiteName: 'zeta', caseId: 'two' })],
      [makeCaseRecord({ suiteName: 'alpha', caseId: 'one' })],
      comparison,
    );
    const second = classifyRuns(
      [makeCaseRecord({ suiteName: 'zeta', caseId: 'two' })].reverse(),
      [makeCaseRecord({ suiteName: 'alpha', caseId: 'one' })].reverse(),
      comparison,
    );

    expect(diffToJson(first)).toBe(diffToJson(second));
  });
});

describe('runToJUnitXml', () => {
  it('escapes XML and emits failures and errors with useful messages', () => {
    const cases = [
      makeCaseRecord({
        caseId: 'failure<&"',
        expectedMetrics: ['quality<&"'],
        metrics: [
          {
            metricName: 'quality<&"',
            kind: 'assertion',
            status: 'evaluated',
            score: 0,
            pass: false,
          },
        ],
      }),
      makeCaseRecord({
        caseId: 'error<&"',
        outcome: 'timeout',
        errorCode: 'timeout',
        errorMessage: 'agent said <no> & "stopped"',
        metrics: [
          {
            metricName: 'judge<&"',
            kind: 'judge',
            status: 'error',
            error: { kind: 'invalid', message: 'bad <answer> & "quote"' },
          },
        ],
      }),
    ];

    const xml = runToJUnitXml(run, cases);
    expect(xml).toContain('name="suite&lt;&amp;&quot;"');
    expect(xml).toContain('failure&lt;&amp;&quot;');
    expect(xml).toContain('failing metrics: quality&lt;&amp;&quot;');
    expect(xml).toContain('agent said &lt;no&gt; &amp; &quot;stopped&quot;');
    expect(xml).toContain('bad &lt;answer&gt; &amp; &quot;quote&quot;');
    expect(xml).not.toContain('agent said <no>');
  });

  it('is stable regardless of input case order', () => {
    const cases = [makeCaseRecord({ caseId: 'zeta' }), makeCaseRecord({ caseId: 'alpha' })];
    expect(runToJUnitXml(run, cases)).toBe(runToJUnitXml(run, [...cases].reverse()));
  });

  it('strips XML 1.0 forbidden controls from attributes and text', () => {
    const xml = runToJUnitXml(run, [
      makeCaseRecord({
        caseId: `case\u0000\u000Bname`,
        suiteName: `suite\u0000\u000Bname`,
        outcome: 'timeout',
        errorCode: 'timeout',
        errorMessage: `message\u0000\u000Btext`,
      }),
    ]);

    expect(xml).not.toContain('\u0000');
    expect(xml).not.toContain('\u000B');
    expect(xml).toContain('name="casename"');
    expect(xml).toContain('messagetext');
  });

  it('filters forbidden Unicode code points while preserving astral characters in well-formed XML', () => {
    const xml = runToJUnitXml(run, [
      makeCaseRecord({
        caseId: 'case\uFFFE\uFFFF\uD800😀',
        suiteName: 'suite😀',
        outcome: 'timeout',
        errorCode: 'timeout',
        errorMessage: 'message\uFFFE\uFFFF\uD800😀',
      }),
    ]);
    expect(xml).not.toMatch(/[\uFFFE\uFFFF\uD800]/);
    expect(xml).toContain('😀');
    expect(hasBalancedTags(xml)).toBe(true);
  });
});
