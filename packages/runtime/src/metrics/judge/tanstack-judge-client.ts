import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import { ownOperation, mustPropagateMetricCause } from '../internal/operation.js';
import { parseWithSchema } from '@attest/contracts';
import type { AnyTextAdapter } from '@tanstack/ai';
import {
  anthropicText,
  createAnthropicChat,
  type AnthropicChatModel,
} from '@tanstack/ai-anthropic';
import { createOpenaiChat, openaiText, type OpenAIChatModel } from '@tanstack/ai-openai';

import type { JsonValue } from '@attest/contracts';

import { AttestMetricError, MetricOperationError, type AttestMetricErrorCode } from '../errors.js';
import { abortReasonOf, composeAbortSignal } from '../internal/abort-signal.js';
import type { JudgeCallOptions, JudgeClient, JudgeRequest } from './judge-client.js';
import type {
  JudgeAttempt,
  JudgeOutcome,
  JudgeRecord,
  JudgeUsage,
} from './judge-outcome-schema.js';
import {
  executeStructuredChat,
  type JudgeAttemptObservation,
  type StructuredChatExecutor,
} from './internal/structured-output.js';
import {
  buildJudgePrompt,
  JUDGE_REQUEST_PARAMS,
  judgeResponseSchema,
  MAXIMUM_STRUCTURED_OUTPUT_ATTEMPTS,
} from './rubric-prompt.js';

/** Supplies optional explicit credentials while leaving undefined keys to provider environment detection. */
type TanstackJudgeClientOptions = {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  /** Replaces the SDK chat call so scoring can be exercised without provider network access. */
  executeChat?: StructuredChatExecutor;
};

/** Represents the only provider prefixes supported by the installed TanStack adapter set. */
type ParsedJudgeModel = { provider: 'anthropic' | 'openai'; model: string };

/** Everything one scoring loop needs; the adapter is already bound to the parsed model. */
type ScoreRequest = {
  adapter: AnyTextAdapter;
  request: JudgeRequest;
  callOptions: JudgeCallOptions;
  executeChat: StructuredChatExecutor;
};

/** Parses the spec's provider/model identifier and rejects unsupported prefixes with a stable error code. */
const parseJudgeModel = (qualifiedModel: string): ParsedJudgeModel => {
  const separatorIndex = qualifiedModel.indexOf('/');

  if (separatorIndex <= 0 || separatorIndex === qualifiedModel.length - 1) {
    throw new AttestMetricError(
      'judge_provider_error',
      `Judge model "${qualifiedModel}" must use provider/model form, for example anthropic/claude-sonnet-5.`,
    );
  }

  const provider = qualifiedModel.slice(0, separatorIndex);
  const model = qualifiedModel.slice(separatorIndex + 1);

  if (provider !== 'anthropic' && provider !== 'openai') {
    throw new AttestMetricError(
      'judge_provider_error',
      `Judge provider "${provider}" is unsupported; configure an anthropic/* or openai/* model.`,
    );
  }

  return { provider, model };
};

/** Creates one provider adapter without exposing API keys to prompts, records, errors, or logging. */
const selectAdapter = (
  parsedModel: ParsedJudgeModel,
  options: TanstackJudgeClientOptions,
): AnyTextAdapter => {
  if (parsedModel.provider === 'anthropic') {
    // SDK model unions age faster than provider APIs; runtime provider failures retain their judge record.
    // SAFETY: The provider prefix was validated above; the SDK sends this model identifier to Anthropic, which resolves supported identifiers at request time.
    const model = parsedModel.model as AnthropicChatModel;

    return options.anthropicApiKey === undefined
      ? anthropicText(model)
      : createAnthropicChat(model, options.anthropicApiKey);
  }

  // SAFETY: The provider prefix was validated above; the SDK sends this model identifier to OpenAI, which resolves supported identifiers at request time.
  const model = parsedModel.model as OpenAIChatModel;

  return options.openaiApiKey === undefined
    ? openaiText(model)
    : createOpenaiChat(model, options.openaiApiKey);
};

/** Sums token usage across attempts, staying undefined when no attempt reported any. */
const totalUsage = (attempts: readonly JudgeAttempt[]): JudgeUsage | undefined => {
  let total: Required<JudgeUsage> | undefined;

  for (const { usage } of attempts) {
    if (usage === undefined) {
      continue;
    }

    total ??= { inputTokens: 0, outputTokens: 0 };
    total = {
      inputTokens: total.inputTokens + (usage.inputTokens ?? 0),
      outputTokens: total.outputTokens + (usage.outputTokens ?? 0),
    };
  }

  return total;
};

/** Builds persisted call evidence without provider credentials or SDK-specific objects. */
const buildJudgeRecord = (request: JudgeRequest, attempts: JudgeAttempt[]): JudgeRecord => {
  const prompt = buildJudgePrompt(request);

  return {
    request: {
      model: request.model,
      system: prompt.system,
      user: prompt.user,
      params: JUDGE_REQUEST_PARAMS,
    },
    rawResponse: attempts.at(-1)?.rawResponse ?? null,
    usage: totalUsage(attempts),
    attempts,
  };
};

/** Appends one attempt, carrying token usage only when the provider reported it. */
const recordAttempt = (
  attempts: JudgeAttempt[],
  observation: JudgeAttemptObservation,
  rawResponse: JsonValue,
  error?: string,
): void => {
  const usage = observation.usageObserved
    ? { inputTokens: observation.inputTokens, outputTokens: observation.outputTokens }
    : undefined;

  attempts.push({ rawResponse, usage, error });
};

/** Maps a failed attempt to its terminal error, or undefined when the metric contract allows a retry. */
const classifyProviderFailure = (
  cause: Error,
  signal: AbortSignal,
  timeoutMs: number | undefined,
): { code: AttestMetricErrorCode; message: string } | undefined => {
  if (signal.aborted) {
    return abortReasonOf(signal) === 'cancelled'
      ? { code: 'metric_cancelled', message: 'Judge request was cancelled.' }
      : { code: 'judge_provider_error', message: `Judge request exceeded ${timeoutMs} ms.` };
  }

  if (cause instanceof AttestMetricError && cause.code === 'judge_unparseable_response') {
    return undefined;
  }

  return { code: 'judge_provider_error', message: `Judge provider call failed: ${cause.message}` };
};

/** Runs the structured chat, retrying malformed structured output exactly once. */
const scoreWithTanStack = ({
  adapter,
  request,
  callOptions,
  executeChat,
}: ScoreRequest): Effect.Effect<JudgeOutcome, Error> =>
  ownOperation((cancelled) =>
    Effect.gen(function* () {
      const prompt = buildJudgePrompt(request);

      const signal = composeAbortSignal(
        AbortSignal.any([cancelled, ...(callOptions.signal ? [callOptions.signal] : [])]),
        callOptions.timeoutMs,
      );

      const attempts: JudgeAttempt[] = [];

      for (let attempt = 1; attempt <= MAXIMUM_STRUCTURED_OUTPUT_ATTEMPTS; attempt += 1) {
        const observation: JudgeAttemptObservation = {
          inputTokens: 0,
          outputTokens: 0,
          usageObserved: false,
          rawResponse: undefined,
        };

        const called = yield* Effect.exit(
          executeChat({
            adapter,
            system: prompt.system,
            user: prompt.user,
            signal,
            observation,
          }),
        );

        if (Exit.isFailure(called)) {
          // A typed branch must not hide another branch's defect or interruption.
          if (mustPropagateMetricCause(called.cause)) return yield* Effect.failCause(called.cause);
          const failed = called.cause.reasons.find((reason) => reason._tag === 'Fail');

          if (failed === undefined) return yield* Effect.failCause(called.cause);
          const cause = failed.error;
          recordAttempt(
            attempts,
            observation,
            observation.rawResponse ?? { error: cause.message },
            cause.message,
          );
          const failure = classifyProviderFailure(cause, signal, callOptions.timeoutMs);

          if (failure !== undefined)
            return yield* new AttestMetricError(failure.code, failure.message, {
              cause,
              details: buildJudgeRecord(request, attempts),
            });
          continue;
        }

        const rawResponse = called.value;

        const verdict = parseWithSchema(judgeResponseSchema, rawResponse);
        const rawEvidence = observation.rawResponse ?? JSON.stringify(rawResponse);

        if (verdict.ok) {
          recordAttempt(attempts, observation, rawEvidence);

          return { verdict: verdict.value, record: buildJudgeRecord(request, attempts) };
        }

        recordAttempt(attempts, observation, rawEvidence, verdict.error.message);
      }

      return yield* Effect.fail(
        new AttestMetricError(
          'judge_unparseable_response',
          'Judge response remained unparseable after one retry.',
          { details: buildJudgeRecord(request, attempts) },
        ),
      );
    }),
  );

/**
 * Creates the TanStack AI implementation of the SDK-free JudgeClient boundary.
 * BYO keys come from explicit options or provider environment detection and never enter JudgeRecord.
 */
const createTanstackJudgeClient = (options: TanstackJudgeClientOptions = {}): JudgeClient => {
  const executeChat = options.executeChat ?? executeStructuredChat;

  return {
    scoreRubric: (request, callOptions = {}) =>
      Effect.gen(function* () {
        const adapter = yield* Effect.try({
          try: () => selectAdapter(parseJudgeModel(request.model), options),
          catch: (cause) =>
            // Model-form errors keep their metric code; SDK adapter construction failures keep their message.
            cause instanceof AttestMetricError
              ? cause
              : new MetricOperationError({ reason: 'foreign', cause }),
        });

        return yield* scoreWithTanStack({ adapter, request, callOptions, executeChat });
      }),
  };
};

export { createTanstackJudgeClient, type TanstackJudgeClientOptions };
