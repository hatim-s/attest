import { valueFromExit } from '../../../internal/effect-exit.js';
import { foreign } from '../../internal/operation.js';
import * as Effect from 'effect/Effect';
import type { JsonValue } from '@attest/contracts';
import { StandardSchemaValidationError } from '@tanstack/ai';
import { describe, expect, it } from 'vitest';

import type { JudgeCallOptions, JudgeRequest } from '../judge-client.js';
import { callStructuredChat, type StructuredChatExecutor } from '../internal/structured-output.js';
import { createTanstackJudgeClient } from '../tanstack-judge-client.js';
import { TestFailure } from '../../../_tests_/support/test-failure.js';

const request: JudgeRequest = {
  model: 'anthropic/claude-sonnet-5',
  rubric: 'Score correctness.',
  document: { input: {}, output: {}, expected: {}, traceSummary: undefined },
};

const malformed = (message: string): StandardSchemaValidationError =>
  Object.assign(new StandardSchemaValidationError([{ message }]), { message });

/** An SDK finalization error that carries a retryable structured-output code and other fields. */
class StructuredOutputError extends Error {
  readonly code = 'structured-output-parse-failed';
  readonly extra = 1;
}

/** Scripts structured-chat results; Errors reject through the production SDK classifier. */
const scriptedExecutor = (scripts: (JsonValue | Error)[]): StructuredChatExecutor => {
  return (chatRequest) => {
    const script = scripts.shift();

    if (script instanceof Error) {
      chatRequest.observation.rawResponse = `error:${script.message}`;

      return callStructuredChat(() => Promise.reject(script));
    }

    if (script === undefined) throw new Error('The judge requested an unscripted response.');
    chatRequest.observation.rawResponse = JSON.stringify(script);

    return Effect.succeed(script);
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
  foreign(
    () =>
      new Promise((_resolve, reject) => {
        chatRequest.observation.rawResponse = 'partial provider bytes';

        if (chatRequest.signal.aborted) {
          reject(new TestFailure({ message: 'aborted provider call' }));

          return;
        }

        chatRequest.signal.addEventListener(
          'abort',
          () => reject(new TestFailure({ message: 'aborted provider call' })),
          {
            once: true,
          },
        );
      }),
  );

describe('createTanstackJudgeClient', () => {
  it.each(['model-only', '/model', 'openai/', 'unsupported/model'])(
    'rejects invalid model %s before any provider call',
    async (model) => {
      const client = createTanstackJudgeClient({ executeChat: scriptedExecutor([]) });

      await expect(
        Effect.runPromiseExit(client.scoreRubric({ ...request, model })).then(valueFromExit),
      ).rejects.toMatchObject({
        code: 'judge_provider_error',
      });
    },
  );

  it('returns a valid first response with one recorded attempt', async () => {
    const outcome = await Effect.runPromiseExit(
      score(scriptedExecutor([{ score: 1, rationale: 'Correct.' }])),
    ).then(valueFromExit);

    expect(outcome.verdict).toEqual({ score: 1, rationale: 'Correct.' });
    expect(outcome.record.attempts).toHaveLength(1);
    expect(outcome.record.request.params).toEqual({
      stream: false,
      structuredOutput: true,
      maximumAttempts: 2,
    });
  });

  it('records both malformed attempts on judge_unparseable_response', async () => {
    // Both retryable SDK shapes: a schema validation error and an Error with a structured-output code.
    const execute = scriptedExecutor([malformed('first'), new StructuredOutputError('second')]);

    await expect(Effect.runPromiseExit(score(execute)).then(valueFromExit)).rejects.toMatchObject({
      code: 'judge_unparseable_response',
      details: { attempts: [{ error: 'first' }, { error: 'second' }] },
    });
  });

  it('recovers from malformed output and retains both attempts', async () => {
    const outcome = await Effect.runPromiseExit(
      score(scriptedExecutor([malformed('first'), { score: 0.75, rationale: 'Recovered.' }])),
    ).then(valueFromExit);

    expect(outcome.verdict).toEqual({ score: 0.75, rationale: 'Recovered.' });
    expect(outcome.record.attempts).toHaveLength(2);
    expect(outcome.record.attempts[0]?.error).toBe('first');
  });

  it('fails a non-Error rejection as a provider error without retrying', async () => {
    const execute: StructuredChatExecutor = () =>
      callStructuredChat(() =>
        // The SDK boundary must handle non-Error rejections, so this test sends one on purpose.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        Promise.reject({ code: 'structured-output-parse-failed' }),
      );

    await expect(Effect.runPromiseExit(score(execute)).then(valueFromExit)).rejects.toMatchObject({
      code: 'judge_provider_error',
      message: 'Judge provider call failed: Foreign operation failed.',
      details: { attempts: [{ error: 'Foreign operation failed.' }] },
    });
  });

  it('retains the attempted record when the provider fails', async () => {
    await expect(
      Effect.runPromiseExit(
        score(scriptedExecutor([new TestFailure({ message: 'provider unavailable' })])),
      ).then(valueFromExit),
    ).rejects.toMatchObject({
      code: 'judge_provider_error',
      details: {
        attempts: [{ rawResponse: 'error:provider unavailable', error: 'provider unavailable' }],
      },
    });
  });

  it('maps mid-call caller abort to metric_cancelled with the attempted record', async () => {
    const controller = new AbortController();

    const scoring = Effect.runPromiseExit(
      score(pendingUntilAbort, { signal: controller.signal }),
    ).then(valueFromExit);

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

    const scoring = Effect.runPromiseExit(
      score(pendingUntilAbort, { signal: controller.signal, timeoutMs: 60_000 }),
    ).then(valueFromExit);

    controller.abort(new DOMException('deadline reached', 'TimeoutError'));

    await expect(scoring).rejects.toMatchObject({
      code: 'judge_provider_error',
      message: 'Judge request exceeded 60000 ms.',
      details: { attempts: [{ rawResponse: 'partial provider bytes' }] },
    });
  });
});
