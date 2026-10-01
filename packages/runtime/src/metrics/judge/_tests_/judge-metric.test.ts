import { describe, expect, it } from 'vitest';

import { deferred } from '../../../_tests_/support/deferred.js';
import { AttestMetricError } from '../../errors.js';
import type { CompletedMetricContext } from '../../metric-evaluation.js';
import type { JudgeMetricDefinition } from '../../metric-definitions.js';
import type { JudgeCache } from '../judge-cache.js';
import type { JudgeClient, JudgeOutcome, JudgeRecord } from '../judge-client.js';
import { evaluateJudgeMetric } from '../judge-metric.js';

const definition: JudgeMetricDefinition = {
  name: 'correctness',
  type: 'judge',
  model: 'anthropic/claude-sonnet-5',
  rubric: 'Score correctness from 0 to 1.',
};
const context: CompletedMetricContext = {
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
const verdict = (score: number): JudgeOutcome => ({
  verdict: { score, rationale: 'Scripted.' },
  record,
});

/** Returns scripted outcomes in order; an Error entry rejects that call. */
const scriptedClient = (scripts: Array<JudgeOutcome | Error>): JudgeClient & { calls: number } => {
  const client = {
    calls: 0,
    scoreRubric: () => {
      client.calls += 1;
      const script = scripts.shift() ?? new Error('No scripted judge outcome remains.');
      return script instanceof Error ? Promise.reject(script) : Promise.resolve(script);
    },
  };
  return client;
};

/** An in-memory cache that counts writes and can fail its first read. */
const memoryCache = (options: { failFirstRead?: boolean; failWrites?: boolean } = {}) => {
  const entries = new Map<string, JudgeOutcome>();
  const cache: JudgeCache & { reads: number; writes: number } = {
    reads: 0,
    writes: 0,
    get: (key) => {
      cache.reads += 1;
      if (options.failFirstRead === true && cache.reads === 1) {
        return Promise.reject(new Error('cache offline'));
      }
      return Promise.resolve(entries.get(key));
    },
    set: (key, outcome) => {
      if (options.failWrites === true) return Promise.reject(new Error('cache offline'));
      cache.writes += 1;
      entries.set(key, outcome);
      return Promise.resolve();
    },
  };
  return cache;
};

describe('evaluateJudgeMetric', () => {
  it('uses the default threshold and records every attempt plus usage', async () => {
    const retryRecord: JudgeRecord = {
      ...record,
      rawResponse: { score: 0.5, rationale: 'At the boundary.' },
      attempts: [
        { rawResponse: '{"score":"invalid"}', usage: { inputTokens: 8 }, error: 'Invalid score.' },
        { rawResponse: { score: 0.5, rationale: 'At the boundary.' } },
      ],
    };
    const client = scriptedClient([
      { verdict: { score: 0.5, rationale: 'At the boundary.' }, record: retryRecord },
    ]);

    await expect(evaluateJudgeMetric(definition, context, { client })).resolves.toMatchObject({
      status: 'evaluated',
      score: 0.5,
      pass: true,
      rationale: 'At the boundary.',
      details: { usage: { inputTokens: 10, outputTokens: 4 } },
      judgeIo: { rawResponse: retryRecord.rawResponse, attempts: retryRecord.attempts },
    });
  });

  it('honors an explicit threshold without inventing a passing score', async () => {
    const evaluation = await evaluateJudgeMetric({ ...definition, threshold: 0.8 }, context, {
      client: scriptedClient([verdict(0.7)]),
    });

    expect(evaluation).toMatchObject({ status: 'evaluated', score: 0.7, pass: false });
  });

  it('uses cached judge evidence without calling the provider', async () => {
    const client = scriptedClient([verdict(1)]);
    const cache = memoryCache();

    const seeded = await evaluateJudgeMetric(definition, context, { client, cache });
    const cached = await evaluateJudgeMetric(definition, context, { client, cache });

    expect(client.calls).toBe(1);
    expect(seeded).toMatchObject({ status: 'evaluated', judgeIo: { cache: 'miss' } });
    expect(cached).toMatchObject({ status: 'evaluated', judgeIo: { cache: 'hit' } });
  });

  it('coalesces concurrent identical cached calls while applying each metric threshold', async () => {
    const provider = deferred<JudgeOutcome>();
    const client: JudgeClient & { calls: number } = {
      calls: 0,
      scoreRubric: () => {
        client.calls += 1;
        return provider.promise;
      },
    };
    const cache = memoryCache();

    const pending = Array.from({ length: 32 }, (_, index) =>
      evaluateJudgeMetric(
        { ...definition, name: `correctness-${index}`, threshold: index === 0 ? 0.8 : 0.6 },
        context,
        { client, cache },
      ),
    );
    await Promise.resolve();
    provider.resolve(verdict(0.7));
    const [first, ...rest] = await Promise.all(pending);

    expect(client.calls).toBe(1);
    expect(cache.writes).toBe(1);
    expect(first).toMatchObject({ pass: false, judgeIo: { cache: 'miss' } });
    for (const evaluation of rest) {
      expect(evaluation).toMatchObject({ pass: true, judgeIo: { cache: 'coalesced' } });
    }
    // Each metric owns a copy of the shared evidence, so hooks cannot mutate another's record.
    expect(first?.judgeIo).not.toBe(rest[0]?.judgeIo);
  });

  it('does not coalesce calls when the cache is disabled', async () => {
    const client = scriptedClient([verdict(0.7), verdict(0.7)]);

    const evaluations = await Promise.all([
      evaluateJudgeMetric(definition, context, { client }),
      evaluateJudgeMetric(definition, context, { client }),
    ]);

    expect(client.calls).toBe(2);
    for (const evaluation of evaluations) {
      expect(evaluation.judgeIo).not.toHaveProperty('cache');
    }
  });

  it('isolates in-flight calls by client, cache, signal, and timeout identity', async () => {
    const provider = deferred<JudgeOutcome>();
    let calls = 0;
    const createClient = (): JudgeClient => ({
      scoreRubric: () => {
        calls += 1;
        return provider.promise;
      },
    });
    const client = createClient();
    const cache = memoryCache();
    const signal = new AbortController().signal;

    const pending = [
      { client, cache, signal, timeoutMs: 100 },
      { client: createClient(), cache, signal, timeoutMs: 100 },
      { client, cache: memoryCache(), signal, timeoutMs: 100 },
      { client, cache, signal: new AbortController().signal, timeoutMs: 100 },
      { client, cache, signal, timeoutMs: 200 },
    ].map((options) => evaluateJudgeMetric(definition, context, options));
    await Promise.resolve();
    provider.resolve(verdict(0.7));

    await expect(Promise.all(pending)).resolves.toHaveLength(5);
    expect(calls).toBe(5);
  });

  it('shares cancellation only between callers using the same signal', async () => {
    const controller = new AbortController();
    let calls = 0;
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
    const cache = memoryCache();

    const pending = [
      evaluateJudgeMetric(definition, context, { client, cache, signal: controller.signal }),
      evaluateJudgeMetric(definition, context, { client, cache, signal: controller.signal }),
    ];
    await Promise.resolve();
    controller.abort();
    const evaluations = await Promise.all(pending);

    expect(calls).toBe(1);
    expect(cache.writes).toBe(0);
    for (const evaluation of evaluations) {
      expect(evaluation).toMatchObject({
        status: 'error',
        error: { kind: 'metric_cancelled', message: 'Judge evaluation was cancelled.' },
      });
    }
  });

  it('does not cache a failed provider call and retries it later', async () => {
    const firstCall = deferred<JudgeOutcome>();
    const client = scriptedClient([]);
    client.scoreRubric = () => {
      client.calls += 1;
      return client.calls === 1 ? firstCall.promise : Promise.resolve(verdict(0.7));
    };
    const cache = memoryCache();

    const failures = [
      evaluateJudgeMetric(definition, context, { client, cache }),
      evaluateJudgeMetric(definition, context, { client, cache }),
    ];
    await Promise.resolve();
    firstCall.reject(new Error('provider unavailable'));
    for (const failure of await Promise.all(failures)) {
      expect(failure).toMatchObject({ status: 'error', error: { kind: 'judge_provider_error' } });
    }
    expect(cache.writes).toBe(0);

    await expect(
      evaluateJudgeMetric(definition, context, { client, cache }),
    ).resolves.toMatchObject({ status: 'evaluated', judgeIo: { cache: 'miss' } });
    expect(client.calls).toBe(2);
    expect(cache.writes).toBe(1);
  });

  it('shares a failed cache lookup with joined callers and retries it later', async () => {
    const client = scriptedClient([verdict(0.7)]);
    const cache = memoryCache({ failFirstRead: true });

    const failures = await Promise.all([
      evaluateJudgeMetric(definition, context, { client, cache }),
      evaluateJudgeMetric(definition, context, { client, cache }),
    ]);
    expect(cache.reads).toBe(1);
    expect(client.calls).toBe(0);
    for (const failure of failures) {
      expect(failure).toMatchObject({ status: 'error', error: { kind: 'judge_provider_error' } });
    }

    await expect(
      evaluateJudgeMetric(definition, context, { client, cache }),
    ).resolves.toMatchObject({ status: 'evaluated', judgeIo: { cache: 'miss' } });
  });

  it('continues with a provider result when advisory cache writes fail', async () => {
    const cache = memoryCache({ failWrites: true });

    await expect(
      evaluateJudgeMetric(definition, context, { client: scriptedClient([verdict(0.7)]), cache }),
    ).resolves.toMatchObject({ status: 'evaluated', judgeIo: { cache: 'miss' } });
  });

  it.each([
    ['judge_provider_error', 'provider unavailable'],
    ['judge_unparseable_response', 'Judge response remained unparseable after one retry.'],
  ] as const)('keeps the %s code and its judge record without a score', async (code, message) => {
    const client = scriptedClient([new AttestMetricError(code, message, { details: record })]);

    const evaluation = await evaluateJudgeMetric(definition, context, { client });

    expect(evaluation).toMatchObject({
      status: 'error',
      error: { kind: code, message },
      details: { rawResponse: record.rawResponse },
    });
    expect(evaluation).not.toHaveProperty('score');
  });

  it('maps an aborted signal to metric_cancelled without calling the provider', async () => {
    const client = scriptedClient([verdict(1)]);
    const controller = new AbortController();
    controller.abort();

    const evaluation = await evaluateJudgeMetric(definition, context, {
      client,
      signal: controller.signal,
    });

    expect(evaluation).toMatchObject({ status: 'error', error: { kind: 'metric_cancelled' } });
    expect(client.calls).toBe(0);
  });
});
