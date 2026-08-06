import {
  StandardSchemaValidationError,
  chat,
  type AnyTextAdapter,
  type ChatMiddleware,
} from '@tanstack/ai';
import {
  ANTHROPIC_MODELS,
  anthropicText,
  createAnthropicChat,
  type AnthropicChatModel,
} from '@tanstack/ai-anthropic';
import {
  OPENAI_CHAT_MODELS,
  createOpenaiChat,
  openaiText,
  type OpenAIChatModel,
} from '@tanstack/ai-openai';

import type { JsonValue } from '@attest/contracts';

import { AttestMetricError } from '../errors.js';
import type {
  JudgeCallOptions,
  JudgeClient,
  JudgeOutcome,
  JudgeRecord,
  JudgeRequest,
  JudgeUsage,
} from './judge-client.js';
import { buildJudgePrompt, judgeResponseSchema } from './rubric-prompt.js';

const MAXIMUM_STRUCTURED_OUTPUT_ATTEMPTS = 2;

/** Supplies optional explicit credentials while leaving undefined keys to provider environment detection. */
type TanstackJudgeClientOptions = { anthropicApiKey?: string; openaiApiKey?: string };

/** Represents the only provider prefixes supported by the installed TanStack adapter set. */
type ParsedJudgeModel = { provider: 'anthropic' | 'openai'; model: string };

/** Tracks a composed provider deadline without leaking timer ownership into the metric evaluator. */
type JudgeAbortContext = {
  controller: AbortController;
  dispose: () => void;
  reason: () => 'cancelled' | 'timeout' | undefined;
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

/** Narrows arbitrary configuration strings against the models supported by this installed adapter version. */
const isAnthropicModel = (model: string): model is AnthropicChatModel =>
  ANTHROPIC_MODELS.some((supportedModel) => supportedModel === model);

/** Narrows arbitrary configuration strings against the models supported by this installed adapter version. */
const isOpenAIModel = (model: string): model is OpenAIChatModel =>
  OPENAI_CHAT_MODELS.some((supportedModel) => supportedModel === model);

/** Creates one provider adapter without exposing API keys to prompts, records, errors, or logging. */
const selectAdapter = (
  parsedModel: ParsedJudgeModel,
  options: TanstackJudgeClientOptions,
): AnyTextAdapter => {
  if (parsedModel.provider === 'anthropic') {
    if (!isAnthropicModel(parsedModel.model)) {
      throw new AttestMetricError(
        'judge_provider_error',
        `Anthropic model "${parsedModel.model}" is not supported by the installed @tanstack/ai-anthropic adapter.`,
      );
    }
    return options.anthropicApiKey === undefined
      ? anthropicText(parsedModel.model)
      : createAnthropicChat(parsedModel.model, options.anthropicApiKey);
  }

  if (!isOpenAIModel(parsedModel.model)) {
    throw new AttestMetricError(
      'judge_provider_error',
      `OpenAI model "${parsedModel.model}" is not supported by the installed @tanstack/ai-openai adapter.`,
    );
  }
  return options.openaiApiKey === undefined
    ? openaiText(parsedModel.model)
    : createOpenaiChat(parsedModel.model, options.openaiApiKey);
};

/** Composes caller cancellation and an optional timeout into the AbortController required by TanStack AI. */
const createJudgeAbortContext = (options: JudgeCallOptions): JudgeAbortContext => {
  const controller = new AbortController();
  let abortReason: 'cancelled' | 'timeout' | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const cancel = (): void => {
    if (abortReason !== undefined) {
      return;
    }
    abortReason = 'cancelled';
    controller.abort(options.signal?.reason);
  };

  if (options.signal?.aborted) {
    cancel();
  } else {
    options.signal?.addEventListener('abort', cancel, { once: true });
  }
  if (options.timeoutMs !== undefined && abortReason === undefined) {
    timeout = setTimeout(() => {
      if (abortReason !== undefined) {
        return;
      }
      abortReason = 'timeout';
      controller.abort(new Error(`Judge request exceeded ${options.timeoutMs} ms.`));
    }, options.timeoutMs);
  }

  return {
    controller,
    reason: () => abortReason,
    dispose: () => {
      options.signal?.removeEventListener('abort', cancel);
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    },
  };
};

/** Identifies SDK structured-output failures that are safe to retry exactly once. */
const isUnparseableResponse = (error: unknown): boolean => {
  if (error instanceof StandardSchemaValidationError) {
    return true;
  }
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return (
      code === 'structured-output-parse-failed' ||
      code === 'structured-output-validation-failed' ||
      code === 'structured-output-missing-result'
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  return /structured output|valid json|parse.*json/i.test(message);
};

/** Captures the provider's verbatim structured bytes and portable usage without logging either. */
const createRecordMiddleware = (observation: {
  inputTokens: number;
  outputTokens: number;
  usageObserved: boolean;
  rawResponse: string | undefined;
}): ChatMiddleware => ({
  name: 'attest-judge-record',
  onChunk: (_context, chunk) => {
    const candidate: unknown = chunk;
    if (typeof candidate !== 'object' || candidate === null) {
      return;
    }
    if (!('type' in candidate) || candidate.type !== 'CUSTOM') {
      return;
    }
    if (!('name' in candidate) || candidate.name !== 'structured-output.complete') {
      return;
    }
    if (
      !('value' in candidate) ||
      typeof candidate.value !== 'object' ||
      candidate.value === null
    ) {
      return;
    }
    if ('raw' in candidate.value && typeof candidate.value.raw === 'string') {
      observation.rawResponse = candidate.value.raw;
    }
  },
  onUsage: (_context, providerUsage) => {
    observation.usageObserved = true;
    observation.inputTokens += providerUsage.promptTokens;
    observation.outputTokens += providerUsage.completionTokens;
  },
});

/** Builds persisted call evidence without provider credentials or SDK-specific objects. */
const buildJudgeRecord = (
  request: JudgeRequest,
  rawResponse: JsonValue,
  attempts: number,
  observation: { inputTokens: number; outputTokens: number; usageObserved: boolean },
): JudgeRecord => {
  const prompt = buildJudgePrompt(request);
  const recordedUsage: JudgeUsage | undefined = observation.usageObserved
    ? {
        inputTokens: observation.inputTokens,
        outputTokens: observation.outputTokens,
      }
    : undefined;

  return {
    request: {
      model: request.model,
      system: prompt.system,
      user: prompt.user,
      params: { stream: false, structuredOutput: true, attempts },
    },
    rawResponse,
    ...(recordedUsage === undefined ? {} : { usage: recordedUsage }),
  };
};

/** Executes the one structured chat operation, retrying only malformed structured output once per spec §3. */
const scoreWithTanStack = async (
  adapter: AnyTextAdapter,
  request: JudgeRequest,
  options: JudgeCallOptions,
): Promise<JudgeOutcome> => {
  const prompt = buildJudgePrompt(request);
  const abortContext = createJudgeAbortContext(options);
  const observation = {
    inputTokens: 0,
    outputTokens: 0,
    usageObserved: false,
    rawResponse: undefined as string | undefined,
  };
  const recordMiddleware = createRecordMiddleware(observation);
  let lastUnparseableMessage = 'The provider returned an invalid structured response.';

  try {
    for (let attempt = 1; attempt <= MAXIMUM_STRUCTURED_OUTPUT_ATTEMPTS; attempt += 1) {
      observation.rawResponse = undefined;
      try {
        const rawResponse = await chat({
          adapter,
          systemPrompts: [prompt.system],
          messages: [{ role: 'user', content: prompt.user }],
          outputSchema: judgeResponseSchema,
          stream: false,
          abortController: abortContext.controller,
          middleware: [recordMiddleware],
          debug: false,
        });
        const verdict = judgeResponseSchema.safeParse(rawResponse);
        if (verdict.success) {
          return {
            verdict: verdict.data,
            record: buildJudgeRecord(
              request,
              observation.rawResponse ?? JSON.stringify(verdict.data),
              attempt,
              observation,
            ),
          };
        }
        lastUnparseableMessage = verdict.error.message;
      } catch (error: unknown) {
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
          const message = error instanceof Error ? error.message : 'unknown provider error';
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
    observation.rawResponse ?? { error: lastUnparseableMessage },
    MAXIMUM_STRUCTURED_OUTPUT_ATTEMPTS,
    observation,
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
