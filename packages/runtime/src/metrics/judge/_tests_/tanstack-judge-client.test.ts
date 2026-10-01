import { StandardSchemaValidationError } from '@tanstack/ai';
import { describe, expect, it } from 'vitest';

import type { JudgeCallOptions, JudgeRequest } from '../judge-client.js';
import type { StructuredChatExecutor } from '../internal/structured-output.js';
import { createTanstackJudgeClient } from '../tanstack-judge-client.js';

const request: JudgeRequest = {
  model: 'anthropic/claude-sonnet-5',
  rubric: 'Score correctness.',
  document: { input: {}, output: {}, expected: {}, traceSummary: undefined },
};

const malformed = (message: string): StandardSchemaValidationError =>
  Object.assign(new StandardSchemaValidationError([{ message }]), { message });

/** Scripts structured-chat results; observations mirror the raw provider bytes. */
const scriptedExecutor = (scripts: unknown[]): StructuredChatExecutor => {
  return (chatRequest) => {
    const script = scripts.shift();
    if (script instanceof Error) {
      chatRequest.observation.rawResponse = `error:${script.message}`;
      return Promise.reject(script);
    }
    chatRequest.observation.rawResponse = JSON.stringify(script);
    return Promise.resolve(script);
  };
};

/** Scores through the public client with an injected chat call and a dummy API key. */
const score = (executeChat: StructuredChatExecutor, callOptions?: JudgeCallOptions) =>
  createTanstackJudgeClient({ anthropicApiKey: 'test-key', executeChat }).scoreRubric(
    request,
    callOptions,
  );

/** Never settles until the composed signal aborts, as a provider call would. */
const pendingUntilAbort: StructuredChatExecutor = (chatRequest) =>
  new Promise((_resolve, reject) => {
    chatRequest.observation.rawResponse = 'partial provider bytes';
    chatRequest.signal.addEventListener('abort', () => reject(new Error('aborted provider call')), {
      once: true,
    });
  });

describe('createTanstackJudgeClient', () => {
  it.each(['model-only', '/model', 'openai/', 'unsupported/model'])(
    'rejects invalid model %s before any provider call',
    async (model) => {
      const client = createTanstackJudgeClient({ executeChat: scriptedExecutor([]) });

      await expect(client.scoreRubric({ ...request, model })).rejects.toMatchObject({
        code: 'judge_provider_error',
      });
    },
  );

  it('returns a valid first response with one recorded attempt', async () => {
    const outcome = await score(scriptedExecutor([{ score: 1, rationale: 'Correct.' }]));

    expect(outcome.verdict).toEqual({ score: 1, rationale: 'Correct.' });
    expect(outcome.record.attempts).toHaveLength(1);
    expect(outcome.record.request.params).toEqual({
      stream: false,
      structuredOutput: true,
      maximumAttempts: 2,
    });
  });

  it('records both malformed attempts on judge_unparseable_response', async () => {
    const execute = scriptedExecutor([malformed('first'), malformed('second')]);

    await expect(score(execute)).rejects.toMatchObject({
      code: 'judge_unparseable_response',
      details: { attempts: [{ error: 'first' }, { error: 'second' }] },
    });
  });

  it('recovers from malformed output and retains both attempts', async () => {
    const outcome = await score(
      scriptedExecutor([malformed('first'), { score: 0.75, rationale: 'Recovered.' }]),
    );

    expect(outcome.verdict).toEqual({ score: 0.75, rationale: 'Recovered.' });
    expect(outcome.record.attempts).toHaveLength(2);
    expect(outcome.record.attempts[0]?.error).toBe('first');
  });

  it('retains the attempted record when the provider fails', async () => {
    await expect(
      score(scriptedExecutor([new Error('provider unavailable')])),
    ).rejects.toMatchObject({
      code: 'judge_provider_error',
      details: {
        attempts: [{ rawResponse: 'error:provider unavailable', error: 'provider unavailable' }],
      },
    });
  });

  it('maps mid-call caller abort to metric_cancelled with the attempted record', async () => {
    const controller = new AbortController();
    const scoring = score(pendingUntilAbort, { signal: controller.signal });
    controller.abort(new Error('caller cancelled'));

    await expect(scoring).rejects.toMatchObject({
      code: 'metric_cancelled',
      details: {
        rawResponse: 'partial provider bytes',
        attempts: [{ rawResponse: 'partial provider bytes', error: 'aborted provider call' }],
      },
    });
  });

  it('maps a deadline abort to judge_provider_error with the attempted record', async () => {
    const controller = new AbortController();
    const scoring = score(pendingUntilAbort, { signal: controller.signal, timeoutMs: 60_000 });
    controller.abort(new DOMException('deadline reached', 'TimeoutError'));

    await expect(scoring).rejects.toMatchObject({
      code: 'judge_provider_error',
      message: 'Judge request exceeded 60000 ms.',
      details: { attempts: [{ rawResponse: 'partial provider bytes' }] },
    });
  });
});
