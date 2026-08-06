import type { AnyTextAdapter } from '@tanstack/ai';
import {
  anthropicText,
  createAnthropicChat,
  type AnthropicChatModel,
} from '@tanstack/ai-anthropic';
import { createOpenaiChat, openaiText, type OpenAIChatModel } from '@tanstack/ai-openai';

import { AttestMetricError } from '../errors.js';
import { createAbortContext } from '../internal/abort-context.js';
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
type TanstackJudgeClientOptions = { anthropicApiKey?: string; openaiApiKey?: string };

/** Represents the only provider prefixes supported by the installed TanStack adapter set. */
type ParsedJudgeModel = { provider: 'anthropic' | 'openai'; model: string };

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

/** Builds persisted call evidence without provider credentials or SDK-specific objects. */
const buildJudgeRecord = (request: JudgeRequest, attempts: JudgeAttempt[]): JudgeRecord => {
  const prompt = buildJudgePrompt(request);
  const inputTokens = attempts.reduce(
    (total, attempt) => total + (attempt.usage?.inputTokens ?? 0),
    0,
  );
  const outputTokens = attempts.reduce(
    (total, attempt) => total + (attempt.usage?.outputTokens ?? 0),
    0,
  );
  const recordedUsage: JudgeUsage | undefined = attempts.some(
    (attempt) => attempt.usage !== undefined,
  )
    ? {
        inputTokens,
        outputTokens,
      }
    : undefined;
  const finalAttempt = attempts.at(-1);

  return {
    request: {
      model: request.model,
      system: prompt.system,
      user: prompt.user,
      params: JUDGE_REQUEST_PARAMS,
    },
    rawResponse: finalAttempt?.rawResponse ?? { error: 'No judge attempt completed.' },
    ...(recordedUsage === undefined ? {} : { usage: recordedUsage }),
    attempts,
  };
};

/** Converts one attempt's observed token delta into portable evidence only when the provider supplied usage. */
const serializeAttemptUsage = (observation: JudgeAttemptObservation): JudgeUsage | undefined =>
  observation.usageObserved
    ? { inputTokens: observation.inputTokens, outputTokens: observation.outputTokens }
    : undefined;

/** Executes the one structured chat operation, retrying only malformed structured output once per spec §3. */
const scoreWithTanStack = async (
  adapter: AnyTextAdapter,
  request: JudgeRequest,
  options: JudgeCallOptions,
  executeChat: StructuredChatExecutor = executeStructuredChat,
): Promise<JudgeOutcome> => {
  const prompt = buildJudgePrompt(request);
  const abortContext = createAbortContext({
    ...options,
    timeoutMessage: `Judge request exceeded ${options.timeoutMs} ms.`,
  });
  const attempts: JudgeAttempt[] = [];
  let lastUnparseableMessage = 'The provider returned an invalid structured response.';

  try {
    for (let attempt = 1; attempt <= MAXIMUM_STRUCTURED_OUTPUT_ATTEMPTS; attempt += 1) {
      const observation: JudgeAttemptObservation = {
        inputTokens: 0,
        outputTokens: 0,
        usageObserved: false,
        rawResponse: undefined,
      };
      try {
        const rawResponse = await executeChat({
          adapter,
          system: prompt.system,
          user: prompt.user,
          abortController: abortContext.controller,
          observation,
        });
        const verdict = judgeResponseSchema.safeParse(rawResponse);
        const rawEvidence =
          observation.rawResponse ?? JSON.stringify(rawResponse) ?? String(rawResponse);
        if (verdict.success) {
          const usage = serializeAttemptUsage(observation);
          attempts.push({ rawResponse: rawEvidence, ...(usage === undefined ? {} : { usage }) });
          return {
            verdict: verdict.data,
            record: buildJudgeRecord(request, attempts),
          };
        }
        lastUnparseableMessage = verdict.error.message;
        const usage = serializeAttemptUsage(observation);
        attempts.push({
          rawResponse: rawEvidence,
          ...(usage === undefined ? {} : { usage }),
          error: lastUnparseableMessage,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const usage = serializeAttemptUsage(observation);
        attempts.push({
          rawResponse: observation.rawResponse ?? { error: message },
          ...(usage === undefined ? {} : { usage }),
          error: message,
        });
        const abortReason = abortContext.reason();
        const record = buildJudgeRecord(request, attempts);
        if (abortReason === 'cancelled') {
          throw new AttestMetricError('metric_cancelled', 'Judge request was cancelled.', {
            cause: error,
            details: record,
          });
        }
        if (abortReason === 'timeout') {
          throw new AttestMetricError(
            'judge_provider_error',
            `Judge request exceeded ${options.timeoutMs} ms.`,
            { cause: error, details: record },
          );
        }
        if (!isUnparseableResponse(error)) {
          throw new AttestMetricError(
            'judge_provider_error',
            `Judge provider call failed: ${message}`,
            { cause: error, details: record },
          );
        }
        lastUnparseableMessage = error instanceof Error ? error.message : String(error);
      }
    }
  } finally {
    abortContext.dispose();
  }

  const record = buildJudgeRecord(
    request,
    attempts.length === 0
      ? [{ rawResponse: { error: lastUnparseableMessage }, error: lastUnparseableMessage }]
      : attempts,
  );
  throw new AttestMetricError(
    'judge_unparseable_response',
    'Judge response remained unparseable after one retry.',
    { details: record },
  );
};

/**
 * Creates the TanStack AI implementation of the SDK-free JudgeClient boundary.
 * BYO keys come from explicit options or provider environment detection and never enter JudgeRecord.
 * Scoring-loop tests inject the narrow structured-chat effect instead of mocking provider SDK internals.
 */
const createTanstackJudgeClient = (options: TanstackJudgeClientOptions = {}): JudgeClient => ({
  scoreRubric: async (request, callOptions = {}) => {
    const parsedModel = parseJudgeModel(request.model);
    const adapter = selectAdapter(parsedModel, options);
    return scoreWithTanStack(adapter, request, callOptions);
  },
});

export {
  createTanstackJudgeClient,
  parseJudgeModel,
  scoreWithTanStack,
  type ParsedJudgeModel,
  type TanstackJudgeClientOptions,
};
