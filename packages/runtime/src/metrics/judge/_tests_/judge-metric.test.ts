import { describe, expect, it } from 'vitest';

import { AttestMetricError } from '../../errors.js';
import type { MetricContext } from '../../metric-evaluation.js';
import type { JudgeCache, JudgeCacheEntry } from '../judge-cache.js';
import type { JudgeClient, JudgeOutcome, JudgeRecord, JudgeRequest } from '../judge-client.js';
import { evaluateJudgeMetric, type JudgeMetricDefinition } from '../judge-metric.js';

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

/** Exposes explicit completion for concurrency tests without adding timers. */
const createDeferred = <T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} => {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
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

  it('coalesces 32 identical cached calls while preserving each metric threshold and evidence', async () => {
    const provider = createDeferred<JudgeOutcome>();
    let calls = 0;
    let writes = 0;
    const client: JudgeClient = {
      scoreRubric: () => {
        calls += 1;
        return provider.promise;
      },
    };
    const cache: JudgeCache = {
      get: () => Promise.resolve(undefined),
      set: () => {
        writes += 1;
        return Promise.resolve();
      },
    };

    const pending = Array.from({ length: 32 }, (_, index) =>
      evaluateJudgeMetric(
        {
          ...definition,
          name: `correctness-${index}`,
          threshold: index === 0 ? 0.8 : 0.6,
        },
        context,
        { client, cache },
      ),
    );
    await Promise.resolve();
    expect(calls).toBe(1);

    provider.resolve({ verdict: { score: 0.7, rationale: 'Shared verdict.' }, record });
    const evaluations = await Promise.all(pending);

    expect(writes).toBe(1);
    expect(evaluations[0]).toMatchObject({
      metricName: 'correctness-0',
      result: { score: 0.7, pass: false, details: { usage: record.usage } },
      judgeIo: { cache: 'miss', rawResponse: record.rawResponse, attempts: record.attempts },
    });
    for (const [index, evaluation] of evaluations.slice(1).entries()) {
      expect(evaluation).toMatchObject({
        metricName: `correctness-${index + 1}`,
        result: { score: 0.7, pass: true, details: { usage: record.usage } },
        judgeIo: {
          cache: 'coalesced',
          rawResponse: record.rawResponse,
          attempts: record.attempts,
        },
      });
    }

    const first = evaluations[0];
    const second = evaluations[1];
    expect(first).not.toBe(second);
    if (first?.status !== 'evaluated' || second?.status !== 'evaluated') {
      throw new Error('Expected coalesced judge calls to produce evaluated results.');
    }
    expect(first.result).not.toBe(second.result);
    expect(first.judgeIo).not.toBe(second.judgeIo);
    if (
      first.judgeIo === null ||
      Array.isArray(first.judgeIo) ||
      typeof first.judgeIo !== 'object' ||
      second.judgeIo === null ||
      Array.isArray(second.judgeIo) ||
      typeof second.judgeIo !== 'object'
    ) {
      throw new Error('Expected judge evidence to be an object.');
    }
    const firstRawResponse = first.judgeIo.rawResponse;
    const secondRawResponse = second.judgeIo.rawResponse;
    if (
      firstRawResponse === null ||
      Array.isArray(firstRawResponse) ||
      typeof firstRawResponse !== 'object' ||
      secondRawResponse === null ||
      Array.isArray(secondRawResponse) ||
      typeof secondRawResponse !== 'object'
    ) {
      throw new Error('Expected judge raw responses to be objects.');
    }
    firstRawResponse.score = 0;
    expect(secondRawResponse.score).toBe(0.7);
  });

  it('does not coalesce calls when the cache is disabled', async () => {
    const provider = createDeferred<JudgeOutcome>();
    let calls = 0;
    const client: JudgeClient = {
      scoreRubric: () => {
        calls += 1;
        return provider.promise;
      },
    };

    const pending = [
      evaluateJudgeMetric(definition, context, { client }),
      evaluateJudgeMetric(definition, context, { client }),
    ];
    expect(calls).toBe(2);
    provider.resolve({ verdict: { score: 0.7, rationale: 'Independent verdict.' }, record });

    const evaluations = await Promise.all(pending);
    for (const evaluation of evaluations) {
      expect(evaluation).toMatchObject({ status: 'evaluated', judgeIo: record });
      expect(evaluation.judgeIo).not.toHaveProperty('cache');
    }
  });

  it('isolates in-flight calls by client, cache, signal, and timeout identity', async () => {
    const provider = createDeferred<JudgeOutcome>();
    let calls = 0;
    const createClient = (): JudgeClient => ({
      scoreRubric: () => {
        calls += 1;
        return provider.promise;
      },
    });
    const createCache = (): JudgeCache => ({
      get: () => Promise.resolve(undefined),
      set: () => Promise.resolve(),
    });
    const client = createClient();
    const cache = createCache();
    const signal = new AbortController().signal;

    const pending = [
      evaluateJudgeMetric(definition, context, { client, cache, signal, timeoutMs: 100 }),
      evaluateJudgeMetric(definition, context, {
        client: createClient(),
        cache,
        signal,
        timeoutMs: 100,
      }),
      evaluateJudgeMetric(definition, context, {
        client,
        cache: createCache(),
        signal,
        timeoutMs: 100,
      }),
      evaluateJudgeMetric(definition, context, {
        client,
        cache,
        signal: new AbortController().signal,
        timeoutMs: 100,
      }),
      evaluateJudgeMetric(definition, context, { client, cache, signal, timeoutMs: 200 }),
    ];
    await Promise.resolve();
    expect(calls).toBe(5);

    provider.resolve({ verdict: { score: 0.7, rationale: 'Isolated verdict.' }, record });
    await expect(Promise.all(pending)).resolves.toHaveLength(5);
  });

  it('shares cancellation only between callers using the same signal', async () => {
    const controller = new AbortController();
    let calls = 0;
    let writes = 0;
    const client: JudgeClient = {
      scoreRubric: (_request, options) => {
        calls += 1;
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      },
    };
    const cache: JudgeCache = {
      get: () => Promise.resolve(undefined),
      set: () => {
        writes += 1;
        return Promise.resolve();
      },
    };

    const pending = [
      evaluateJudgeMetric(definition, context, { client, cache, signal: controller.signal }),
      evaluateJudgeMetric(definition, context, { client, cache, signal: controller.signal }),
    ];
    await Promise.resolve();
    expect(calls).toBe(1);
    controller.abort();

    const evaluations = await Promise.all(pending);
    expect(writes).toBe(0);
    for (const evaluation of evaluations) {
      expect(evaluation).toMatchObject({
        status: 'error',
        error: { code: 'metric_cancelled', message: 'Judge evaluation was cancelled.' },
      });
    }
  });

  it('cleans failed provider calls and retries without caching the error', async () => {
    const firstCall = createDeferred<JudgeOutcome>();
    let calls = 0;
    let writes = 0;
    const client: JudgeClient = {
      scoreRubric: () => {
        calls += 1;
        return calls === 1
          ? firstCall.promise
          : Promise.resolve({ verdict: { score: 0.7, rationale: 'Recovered.' }, record });
      },
    };
    const cache: JudgeCache = {
      get: () => Promise.resolve(undefined),
      set: () => {
        writes += 1;
        return Promise.resolve();
      },
    };
    const firstEvaluations = [
      evaluateJudgeMetric(definition, context, { client, cache }),
      evaluateJudgeMetric(definition, context, { client, cache }),
    ];
    await Promise.resolve();
    firstCall.reject(new Error('provider unavailable'));

    const failures = await Promise.all(firstEvaluations);
    expect(calls).toBe(1);
    expect(writes).toBe(0);
    for (const failure of failures) {
      expect(failure).toMatchObject({
        status: 'error',
        error: { code: 'judge_provider_error' },
      });
    }

    await expect(
      evaluateJudgeMetric(definition, context, { client, cache }),
    ).resolves.toMatchObject({
      status: 'evaluated',
      judgeIo: { cache: 'miss' },
    });
    expect(calls).toBe(2);
    expect(writes).toBe(1);
  });

  it('cleans a failed cache lookup so a later call can retry', async () => {
    let reads = 0;
    let calls = 0;
    const client: JudgeClient = {
      scoreRubric: () => {
        calls += 1;
        return Promise.resolve({ verdict: { score: 0.7, rationale: 'Recovered.' }, record });
      },
    };
    const cache: JudgeCache = {
      get: () => {
        reads += 1;
        return reads === 1
          ? Promise.reject(new Error('cache offline'))
          : Promise.resolve(undefined);
      },
      set: () => Promise.resolve(),
    };

    const failures = await Promise.all([
      evaluateJudgeMetric(definition, context, { client, cache }),
      evaluateJudgeMetric(definition, context, { client, cache }),
    ]);
    expect(reads).toBe(1);
    expect(calls).toBe(0);
    for (const failure of failures) {
      expect(failure).toMatchObject({
        status: 'error',
        error: { code: 'judge_provider_error' },
      });
    }

    await expect(
      evaluateJudgeMetric(definition, context, { client, cache }),
    ).resolves.toMatchObject({
      status: 'evaluated',
      judgeIo: { cache: 'miss' },
    });
    expect(reads).toBe(2);
    expect(calls).toBe(1);
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
