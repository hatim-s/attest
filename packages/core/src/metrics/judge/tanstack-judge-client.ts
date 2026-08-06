import { chat, type AnyTextAdapter } from '@tanstack/ai';
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
  createRecordMiddleware,
  isUnparseableResponse,
  type JudgeAttemptObservation,
} from './internal/structured-output.js';
import { buildJudgePrompt, judgeResponseSchema } from './rubric-prompt.js';

const MAXIMUM_STRUCTURED_OUTPUT_ATTEMPTS = 2;

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
    // SDK model unions age faster than provider APIs; provider failures surface as judge_provider_error.
    const model = parsedModel.model as AnthropicChatModel;
    return options.anthropicApiKey === undefined
      ? anthropicText(model)
      : createAnthropicChat(model, options.anthropicApiKey);
  }

  // SDK model unions age faster than provider APIs; provider failures surface as judge_provider_error.
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
      params: { stream: false, structuredOutput: true, attempts: attempts.length },
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
        const rawResponse = await chat({
          adapter,
          systemPrompts: [prompt.system],
          messages: [{ role: 'user', content: prompt.user }],
          outputSchema: judgeResponseSchema,
          stream: false,
          abortController: abortContext.controller,
          middleware: [createRecordMiddleware(observation)],
          debug: false,
        });
        const verdict = judgeResponseSchema.safeParse(rawResponse);
        const rawEvidence = observation.rawResponse ?? JSON.stringify(rawResponse);
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
        if (abortReason === 'cancelled') {
          throw new AttestMetricError('judge_provider_error', 'Judge request was cancelled.', {
            cause: error,
          });
        }
        if (abortReason === 'timeout') {
          throw new AttestMetricError(
            'judge_provider_error',
            `Judge request exceeded ${options.timeoutMs} ms.`,
            { cause: error },
          );
        }
        if (!isUnparseableResponse(error)) {
          throw new AttestMetricError(
            'judge_provider_error',
            `Judge provider call failed: ${message}`,
            { cause: error },
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
 */
const createTanstackJudgeClient = (options: TanstackJudgeClientOptions = {}): JudgeClient => ({
  scoreRubric: async (request, callOptions = {}) => {
    const parsedModel = parseJudgeModel(request.model);
    const adapter = selectAdapter(parsedModel, options);
    return scoreWithTanStack(adapter, request, callOptions);
  },
});

// Provider SDK calls are covered by their contract plus JudgeClient double tests. We intentionally avoid
// mocking SDK internals, and the installed adapters do not expose a cheap local-stub base URL uniformly.
export {
  createTanstackJudgeClient,
  parseJudgeModel,
  type ParsedJudgeModel,
  type TanstackJudgeClientOptions,
};
