import type { AnyTextAdapter } from '@tanstack/ai';
import { describe, expect, it, vi } from 'vitest';

import { AttestMetricError } from '../../errors.js';
import type { JudgeRequest } from '../judge-client.js';
import type {
  StructuredChatExecutor,
  StructuredChatRequest,
} from '../internal/structured-output.js';
import {
  createTanstackJudgeClient,
  parseJudgeModel,
  scoreWithTanStack,
} from '../tanstack-judge-client.js';

const request: JudgeRequest = {
  model: 'unsupported/model',
  rubric: 'Score correctness.',
  document: { input: {}, output: {}, expected: {}, traceSummary: undefined },
};

/** Satisfies the installed AnyTextAdapter declaration; injected executors never invoke its methods. */
const adapter: AnyTextAdapter = {
  kind: 'text',
  name: 'attest-test',
  model: 'test-model',
  '~types': {
    providerOptions: {},
    inputModalities: ['text'],
    messageMetadataByModality: {},
    toolCapabilities: [],
    toolCallMetadata: undefined,
    systemPromptMetadata: undefined,
  },
  chatStream: async function* () {
    await Promise.resolve();
    yield* [];
  },
  structuredOutput: () => Promise.resolve({ data: {}, rawText: '{}' }),
};

/** Produces an injected structured-chat effect whose observations mirror provider raw bytes. */
const createScriptedExecutor = (
  scripts: unknown[],
): { execute: StructuredChatExecutor; calls: StructuredChatRequest[] } => {
  const calls: StructuredChatRequest[] = [];
  const execute: StructuredChatExecutor = (chatRequest) => {
    calls.push(chatRequest);
    const script = scripts.shift();
    if (script === undefined) {
      return Promise.reject(new Error('No scripted structured response remains.'));
    }
    if (script instanceof Error) {
      chatRequest.observation.rawResponse = `error:${script.message}`;
      return Promise.reject(script);
    }
    chatRequest.observation.rawResponse = JSON.stringify(script);
    return Promise.resolve(script);
  };
  return { execute, calls };
};

describe('parseJudgeModel', () => {
  it('keeps the provider and full model suffix', () => {
    expect(parseJudgeModel('openai/family/model')).toEqual({
      provider: 'openai',
      model: 'family/model',
    });
  });

  it('accepts a provider-qualified model string that the SDK does not yet enumerate', () => {
    expect(parseJudgeModel('anthropic/future-model-2027')).toEqual({
      provider: 'anthropic',
      model: 'future-model-2027',
    });
  });

  it.each(['model-only', '/model', 'openai/', 'unsupported/model'])(
    'rejects invalid model %s',
    (model) => {
      expect(() => parseJudgeModel(model)).toThrow(AttestMetricError);
      try {
        parseJudgeModel(model);
      } catch (error: unknown) {
        expect(error).toHaveProperty('code', 'judge_provider_error');
      }
    },
  );
});

describe('createTanstackJudgeClient', () => {
  it('rejects an unknown provider before any SDK or network call', async () => {
    const client = createTanstackJudgeClient();

    await expect(client.scoreRubric(request)).rejects.toHaveProperty(
      'code',
      'judge_provider_error',
    );
    await expect(client.scoreRubric(request)).rejects.toThrow('unsupported');
  });
});

describe('scoreWithTanStack', () => {
  it('returns a valid first response with one recorded attempt', async () => {
    const scripted = createScriptedExecutor([{ score: 1, rationale: 'Correct.' }]);

    const outcome = await scoreWithTanStack(adapter, request, {}, scripted.execute);

    expect(outcome.verdict).toEqual({ score: 1, rationale: 'Correct.' });
    expect(outcome.record.attempts).toHaveLength(1);
    expect(outcome.record.request.params).toEqual({
      stream: false,
      structuredOutput: true,
      maximumAttempts: 2,
    });
  });

  it('records both malformed attempts on judge_unparseable_response', async () => {
    const scripted = createScriptedExecutor([
      new Error('structured output malformed first'),
      new Error('structured output malformed second'),
    ]);

    const scoring = scoreWithTanStack(adapter, request, {}, scripted.execute);

    await expect(scoring).rejects.toMatchObject({
      code: 'judge_unparseable_response',
      details: {
        attempts: [
          { error: 'structured output malformed first' },
          { error: 'structured output malformed second' },
        ],
      },
    });
    expect(scripted.calls).toHaveLength(2);
  });

  it('recovers from malformed output and retains both attempts', async () => {
    const scripted = createScriptedExecutor([
      new Error('structured output malformed first'),
      { score: 0.75, rationale: 'Recovered.' },
    ]);

    const outcome = await scoreWithTanStack(adapter, request, {}, scripted.execute);

    expect(outcome.verdict).toEqual({ score: 0.75, rationale: 'Recovered.' });
    expect(outcome.record.attempts).toHaveLength(2);
    expect(outcome.record.attempts[0]?.error).toBe('structured output malformed first');
  });

  it('maps mid-call caller abort to metric_cancelled with the attempted record', async () => {
    const controller = new AbortController();
    const execute: StructuredChatExecutor = (chatRequest) =>
      new Promise((_resolve, reject) => {
        chatRequest.observation.rawResponse = 'partial provider bytes';
        chatRequest.abortController.signal.addEventListener(
          'abort',
          () => reject(new Error('aborted provider call')),
          { once: true },
        );
        queueMicrotask(() => controller.abort(new Error('caller cancelled')));
      });

    await expect(
      scoreWithTanStack(adapter, request, { signal: controller.signal }, execute),
    ).rejects.toMatchObject({
      code: 'metric_cancelled',
      details: {
        rawResponse: 'partial provider bytes',
        attempts: [{ rawResponse: 'partial provider bytes', error: 'aborted provider call' }],
      },
    });
  });

  it('retains the attempted record when the provider fails', async () => {
    const scripted = createScriptedExecutor([new Error('provider unavailable')]);

    await expect(scoreWithTanStack(adapter, request, {}, scripted.execute)).rejects.toMatchObject({
      code: 'judge_provider_error',
      details: {
        attempts: [
          {
            rawResponse: 'error:provider unavailable',
            error: 'provider unavailable',
          },
        ],
      },
    });
  });

  it('retains the attempted record when the provider times out', async () => {
    vi.useFakeTimers();
    try {
      const execute: StructuredChatExecutor = (chatRequest) =>
        new Promise((_resolve, reject) => {
          chatRequest.observation.rawResponse = 'partial timeout bytes';
          chatRequest.abortController.signal.addEventListener(
            'abort',
            () => reject(new Error('provider deadline reached')),
            { once: true },
          );
        });
      const scoring = scoreWithTanStack(adapter, request, { timeoutMs: 5 }, execute);
      const assertion = expect(scoring).rejects.toMatchObject({
        code: 'judge_provider_error',
        details: {
          attempts: [
            {
              rawResponse: 'partial timeout bytes',
              error: 'provider deadline reached',
            },
          ],
        },
      });

      await vi.advanceTimersByTimeAsync(5);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
