import type { AnyTextAdapter } from '@tanstack/ai';
import {
  anthropicText,
  createAnthropicChat,
  type AnthropicChatModel,
} from '@tanstack/ai-anthropic';
import { createOpenaiChat, openaiText, type OpenAIChatModel } from '@tanstack/ai-openai';

import type { JsonValue } from '@attest/contracts';

import { AttestMetricError, type AttestMetricErrorCode } from '../errors.js';
import { abortReasonOf, composeAbortSignal } from '../internal/abort-signal.js';
import type {
  JudgeAttempt,
  JudgeCallOptions,
  JudgeClient,
  JudgeOutcome,
  JudgeRecord,
  JudgeRequest,
  JudgeUsage,
} from './judge-client.js';
import {
  executeStructuredChat,
  isUnparseableResponse,
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
    const model = parsedModel.model as AnthropicChatModel;
    return options.anthropicApiKey === undefined
      ? anthropicText(model)
      : createAnthropicChat(model, options.anthropicApiKey);
  }

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
    total.inputTokens += usage.inputTokens ?? 0;
    total.outputTokens += usage.outputTokens ?? 0;
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

/** Maps a failed attempt to its terminal error, or undefined when spec §3 allows a retry. */
const classifyProviderFailure = (
  error: unknown,
  signal: AbortSignal,
  timeoutMs: number | undefined,
): { code: AttestMetricErrorCode; message: string } | undefined => {
  if (signal.aborted) {
    return abortReasonOf(signal) === 'cancelled'
      ? { code: 'metric_cancelled', message: 'Judge request was cancelled.' }
      : { code: 'judge_provider_error', message: `Judge request exceeded ${timeoutMs} ms.` };
  }
  if (isUnparseableResponse(error)) {
    return undefined;
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'judge_provider_error', message: `Judge provider call failed: ${message}` };
};

/** Runs the structured chat, retrying malformed structured output exactly once per spec §3. */
const scoreWithTanStack = async ({
  adapter,
  request,
  callOptions,
  executeChat,
}: ScoreRequest): Promise<JudgeOutcome> => {
  const prompt = buildJudgePrompt(request);
  const signal = composeAbortSignal(callOptions.signal, callOptions.timeoutMs);
  const attempts: JudgeAttempt[] = [];

  for (let attempt = 1; attempt <= MAXIMUM_STRUCTURED_OUTPUT_ATTEMPTS; attempt += 1) {
    const observation: JudgeAttemptObservation = {
      inputTokens: 0,
      outputTokens: 0,
      usageObserved: false,
      rawResponse: undefined,
    };
    let rawResponse: unknown;
    try {
      rawResponse = await executeChat({
        adapter,
        system: prompt.system,
        user: prompt.user,
        signal,
        observation,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      recordAttempt(attempts, observation, observation.rawResponse ?? { error: message }, message);
      const failure = classifyProviderFailure(error, signal, callOptions.timeoutMs);
      if (failure !== undefined) {
        throw new AttestMetricError(failure.code, failure.message, {
          cause: error,
          details: buildJudgeRecord(request, attempts),
        });
      }
      continue;
    }

    const verdict = judgeResponseSchema.safeParse(rawResponse);
    const rawEvidence = observation.rawResponse ?? JSON.stringify(rawResponse);
    if (verdict.success) {
      recordAttempt(attempts, observation, rawEvidence);
      return { verdict: verdict.data, record: buildJudgeRecord(request, attempts) };
    }
    recordAttempt(attempts, observation, rawEvidence, verdict.error.message);
  }

  throw new AttestMetricError(
    'judge_unparseable_response',
    'Judge response remained unparseable after one retry.',
    { details: buildJudgeRecord(request, attempts) },
  );
};

/**
 * Creates the TanStack AI implementation of the SDK-free JudgeClient boundary.
 * BYO keys come from explicit options or provider environment detection and never enter JudgeRecord.
 */
const createTanstackJudgeClient = (options: TanstackJudgeClientOptions = {}): JudgeClient => {
  const executeChat = options.executeChat ?? executeStructuredChat;
  return {
    scoreRubric: async (request, callOptions = {}) => {
      const adapter = selectAdapter(parseJudgeModel(request.model), options);
      return scoreWithTanStack({ adapter, request, callOptions, executeChat });
    },
  };
};

export { createTanstackJudgeClient, type TanstackJudgeClientOptions };
