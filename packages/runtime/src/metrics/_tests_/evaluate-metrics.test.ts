import { fileURLToPath } from 'node:url';

import type { MetricDefinition } from '@attest/contracts';
import { describe, expect, it } from 'vitest';

import { evaluateMetrics } from '../evaluate-metrics.js';
import type { MetricContext } from '../metric-evaluation.js';

const context: MetricContext = {
  caseDefinition: { id: 'capital', input: { question: 'Capital?' }, expected: 'Paris' },
  execution: { outcome: 'completed', output: 'Paris', trace: null },
};
const judgeDefinition = {
  model: 'anthropic/claude-sonnet-5',
  rubric: 'Score correctness from 0 to 1.',
};

describe('evaluateMetrics', () => {
  it('preserves definition order across assertion, exec, and unconfigured judge kinds', async () => {
    const executableFixture = fileURLToPath(
      new URL('./fixtures/exec-metric/result.mjs', import.meta.url),
    );
    const definitions: MetricDefinition[] = [
      {
        name: 'assert-first',
        type: 'assertion',
        assert: [{ equals: { path: '$.output', value: 'Paris' } }],
      },
      { name: 'exec-second', type: 'exec', command: [process.execPath, executableFixture] },
      { name: 'judge-third', type: 'judge', ...judgeDefinition },
    ];

    const evaluations = await evaluateMetrics(definitions, context);

    expect(evaluations.map((evaluation) => evaluation.metricName)).toEqual([
      'assert-first',
      'exec-second',
      'judge-third',
    ]);
    expect(evaluations[0]).toMatchObject({ status: 'evaluated', result: { pass: true } });
    expect(evaluations[1]).toMatchObject({ status: 'evaluated', result: { pass: true } });
    expect(evaluations[2]).toMatchObject({
      status: 'error',
      error: { code: 'judge_provider_error' },
    });
    expect(evaluations[2]?.status === 'error' ? evaluations[2].error.message : '').toContain(
      'judgeClient',
    );
    for (const evaluation of evaluations) {
      expect(evaluation.durationMs).toEqual(expect.any(Number));
      expect(evaluation.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('applies the same no-output skip semantics to every metric kind', async () => {
    const incompleteContext: MetricContext = {
      ...context,
      execution: { outcome: 'invocation_error', trace: null },
    };
    const definitions: MetricDefinition[] = [
      { name: 'assertion', type: 'assertion', assert: [{ exists: { path: '$.output' } }] },
      { name: 'exec', type: 'exec', command: ['must-not-run'] },
      { name: 'judge', type: 'judge', ...judgeDefinition },
    ];

    const evaluations = await evaluateMetrics(definitions, incompleteContext);

    expect(evaluations).toHaveLength(3);
    expect(evaluations.every((evaluation) => evaluation.status === 'error')).toBe(true);
    expect(
      evaluations.every(
        (evaluation) =>
          evaluation.status === 'error' && evaluation.error.code === 'skipped_no_output',
      ),
    ).toBe(true);
  });

  it('isolates unexpected assertion exceptions and continues with later metrics', async () => {
    const definitions: MetricDefinition[] = [
      {
        name: 'invalid-regex',
        type: 'assertion',
        assert: [{ regex: { path: '$.output', pattern: '[' } }],
      },
      {
        name: 'later-assertion',
        type: 'assertion',
        assert: [{ equals: { path: '$.output', value: 'Paris' } }],
      },
    ];

    const evaluations = await evaluateMetrics(definitions, context);

    expect(evaluations).toMatchObject([
      { metricName: 'invalid-regex', status: 'error', error: { code: 'internal_error' } },
      { metricName: 'later-assertion', status: 'evaluated', result: { pass: true } },
    ]);
  });

  it('maps invalid JSON Schema configuration to its typed metric error', async () => {
    const evaluations = await evaluateMetrics(
      [
        {
          name: 'invalid-schema',
          type: 'assertion',
          assert: [
            {
              json_schema: {
                path: '$.output',
                schema: { type: 'not-a-json-schema-type' },
              },
            },
          ],
        },
      ],
      context,
    );

    expect(evaluations).toMatchObject([
      { status: 'error', error: { code: 'invalid_json_schema' } },
    ]);
  });
});
