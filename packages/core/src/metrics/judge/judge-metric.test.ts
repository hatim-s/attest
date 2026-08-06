import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { MetricDefinition } from '@attest/contracts';

import { evaluateMetrics } from '../evaluate-metrics.js';
import { AttestMetricError } from '../errors.js';
import type { MetricContext } from '../metric-evaluation.js';
import type { JudgeCache, JudgeCacheEntry } from './judge-cache.js';
import type { JudgeClient, JudgeOutcome, JudgeRecord, JudgeRequest } from './judge-client.js';
import { evaluateJudgeMetric, type JudgeMetricDefinition } from './judge-metric.js';

const definition: JudgeMetricDefinition = {
  name: 'correctness',
  type: 'judge',
  model: 'anthropic/claude-sonnet-5',
  rubric: 'Score correctness from 0 to 1.',
};
const context: MetricContext = {
  caseDefinition: { id: 'capital', input: { question: 'Capital?' }, expected: 'Paris' },
  execution: { outcome: 'completed', output: 'Paris', trace: null },
};
const record: JudgeRecord = {
  request: {
    model: definition.model,
    system: 'system',
    user: 'user',
    params: { stream: false },
  },
  rawResponse: { score: 0.7, rationale: 'Acceptable.' },
  usage: { inputTokens: 10, outputTokens: 4 },
  attempts: [
    {
      rawResponse: { score: 0.7, rationale: 'Acceptable.' },
      usage: { inputTokens: 10, outputTokens: 4 },
    },
  ],
};

/** Produces a no-network JudgeClient whose scripted values make error paths deterministic. */
const createScriptedClient = (
  scripts: Array<JudgeOutcome | Error>,
): { client: JudgeClient; requests: JudgeRequest[] } => {
  const requests: JudgeRequest[] = [];
  const client: JudgeClient = {
    scoreRubric: (request) => {
      requests.push(request);
      const script = scripts.shift();
      if (script === undefined) {
        return Promise.reject(new Error('No scripted judge outcome remains.'));
      }
      if (script instanceof Error) {
        return Promise.reject(script);
      }
      return Promise.resolve(script);
    },
  };
  return { client, requests };
};

describe('evaluateJudgeMetric', () => {
  it('uses the default threshold and records judge I/O plus usage', async () => {
    const { client } = createScriptedClient([
      { verdict: { score: 0.5, rationale: 'At the boundary.' }, record },
    ]);

    const evaluation = await evaluateJudgeMetric(definition, context, { client });

    expect(evaluation).toMatchObject({
      status: 'evaluated',
      result: {
        score: 0.5,
        pass: true,
        rationale: 'At the boundary.',
        details: { usage: { inputTokens: 10, outputTokens: 4 } },
      },
      judgeIo: record,
    });
  });

  it('serializes every judge retry attempt alongside the final raw response', async () => {
    const retryRecord: JudgeRecord = {
      ...record,
      rawResponse: { score: 1, rationale: 'Recovered.' },
      attempts: [
        {
          rawResponse: '{"score":"invalid"}',
          usage: { inputTokens: 8, outputTokens: 2 },
          error: 'Invalid score.',
        },
        {
          rawResponse: { score: 1, rationale: 'Recovered.' },
          usage: { inputTokens: 9, outputTokens: 3 },
        },
      ],
    };
    const { client } = createScriptedClient([
      { verdict: { score: 1, rationale: 'Recovered.' }, record: retryRecord },
    ]);

    await expect(evaluateJudgeMetric(definition, context, { client })).resolves.toMatchObject({
      judgeIo: {
        rawResponse: { score: 1, rationale: 'Recovered.' },
        attempts: retryRecord.attempts,
      },
    });
  });

  it('honors an explicit threshold without inventing a passing score', async () => {
    const { client } = createScriptedClient([
      { verdict: { score: 0.7, rationale: 'Below target.' }, record },
    ]);

    const evaluation = await evaluateJudgeMetric({ ...definition, threshold: 0.8 }, context, {
      client,
    });

    expect(evaluation).toMatchObject({ status: 'evaluated', result: { score: 0.7, pass: false } });
  });

  it('uses cached judge evidence without calling the provider', async () => {
    let calls = 0;
    const client: JudgeClient = {
      scoreRubric: () => {
        calls += 1;
        return Promise.resolve({ verdict: { score: 1, rationale: 'unused' }, record });
      },
    };
    const entries = new Map<string, JudgeCacheEntry>();
    const cache: JudgeCache = {
      get: (key) => Promise.resolve(entries.get(key)),
      set: (key, entry) => {
        entries.set(key, entry);
        return Promise.resolve();
      },
    };
    const seeded = await evaluateJudgeMetric(definition, context, { client, cache });
    const cached = await evaluateJudgeMetric(definition, context, { client, cache });

    expect(calls).toBe(1);
    expect(seeded).toMatchObject({ status: 'evaluated', judgeIo: { cache: 'miss' } });
    expect(cached).toMatchObject({ status: 'evaluated', judgeIo: { cache: 'hit' } });
  });

  it('continues with a provider result when advisory cache writes fail', async () => {
    const { client } = createScriptedClient([
      { verdict: { score: 0.7, rationale: 'Available.' }, record },
    ]);
    const cache: JudgeCache = {
      get: () => Promise.resolve(undefined),
      set: () => Promise.reject(new Error('cache offline')),
    };

    await expect(
      evaluateJudgeMetric(definition, context, { client, cache }),
    ).resolves.toMatchObject({
      status: 'evaluated',
      judgeIo: { cache: 'miss' },
    });
  });

  it('maps provider failures to judge_provider_error without a fake score', async () => {
    const providerError = new AttestMetricError('judge_provider_error', 'provider unavailable', {
      details: record,
    });
    const { client } = createScriptedClient([providerError]);

    const evaluation = await evaluateJudgeMetric(definition, context, { client });

    expect(evaluation).toMatchObject({
      status: 'error',
      error: { code: 'judge_provider_error', message: 'provider unavailable', details: record },
    });
    expect(evaluation).not.toHaveProperty('result');
  });

  it('retains the record when a response remains unparseable', async () => {
    const error = new AttestMetricError(
      'judge_unparseable_response',
      'Judge response remained unparseable after one retry.',
      { details: record },
    );
    const { client } = createScriptedClient([error]);

    const evaluation = await evaluateJudgeMetric(definition, context, { client });

    expect(evaluation).toMatchObject({
      status: 'error',
      error: { code: 'judge_unparseable_response', details: record },
    });
  });

  it('short-circuits non-completed executions without calling the client', async () => {
    const scripted = createScriptedClient([{ verdict: { score: 1, rationale: 'unused' }, record }]);
    const incompleteContext: MetricContext = {
      ...context,
      execution: { outcome: 'timeout', trace: null },
    };

    const evaluation = await evaluateJudgeMetric(definition, incompleteContext, {
      client: scripted.client,
    });

    expect(evaluation).toMatchObject({ status: 'error', error: { code: 'skipped_no_output' } });
    expect(scripted.requests).toHaveLength(0);
  });

  it('maps an aborted signal to metric_cancelled', async () => {
    const scripted = createScriptedClient([{ verdict: { score: 1, rationale: 'unused' }, record }]);
    const controller = new AbortController();
    controller.abort();

    const evaluation = await evaluateJudgeMetric(definition, context, {
      client: scripted.client,
      signal: controller.signal,
    });

    expect(evaluation).toMatchObject({
      status: 'error',
      error: { code: 'metric_cancelled' },
    });
    expect(evaluation.status === 'error' ? evaluation.error.message : '').toContain('cancelled');
    expect(scripted.requests).toHaveLength(0);
  });
});

describe('evaluateMetrics', () => {
  it('preserves definition order across assertion, exec, and unconfigured judge kinds', async () => {
    const executableFixture = fileURLToPath(
      new URL('../exec-metric.fixtures/result.mjs', import.meta.url),
    );
    const definitions: MetricDefinition[] = [
      {
        name: 'assert-first',
        type: 'assertion',
        assert: [{ equals: { path: '$.output', value: 'Paris' } }],
      },
      { name: 'exec-second', type: 'exec', command: [process.execPath, executableFixture] },
      { name: 'judge-third', type: 'judge', model: definition.model, rubric: definition.rubric },
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
      { name: 'judge', type: 'judge', model: definition.model, rubric: definition.rubric },
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
