import {
  chat,
  StandardSchemaValidationError,
  type AnyTextAdapter,
  type ChatMiddleware,
} from '@tanstack/ai';

import { judgeResponseSchema } from '../rubric-prompt.js';

/** Captures one provider attempt without conflating its evidence with an earlier structured-output retry. */
type JudgeAttemptObservation = {
  inputTokens: number;
  outputTokens: number;
  usageObserved: boolean;
  rawResponse: string | undefined;
};

/** Defines the narrow SDK invocation seam used to test retry behavior without provider network calls. */
type StructuredChatRequest = {
  adapter: AnyTextAdapter;
  system: string;
  user: string;
  abortController: AbortController;
  observation: JudgeAttemptObservation;
};

/** Executes one schema-constrained TanStack chat call. */
type StructuredChatExecutor = (request: StructuredChatRequest) => Promise<unknown>;

/** Identifies SDK structured-output failures that metric spec §3 permits retrying exactly once. */
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

/** Captures one attempt's provider bytes and token deltas without exposing provider SDK objects to persistence. */
const createRecordMiddleware = (observation: JudgeAttemptObservation): ChatMiddleware => ({
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

/** Keeps the SDK call at an injectable effect boundary while the scoring loop remains deterministic. */
const executeStructuredChat: StructuredChatExecutor = async (request) =>
  chat({
    adapter: request.adapter,
    systemPrompts: [request.system],
    messages: [{ role: 'user', content: request.user }],
    outputSchema: judgeResponseSchema,
    stream: false,
    abortController: request.abortController,
    middleware: [createRecordMiddleware(request.observation)],
    debug: false,
  });

export {
  createRecordMiddleware,
  executeStructuredChat,
  isUnparseableResponse,
  type JudgeAttemptObservation,
  type StructuredChatExecutor,
  type StructuredChatRequest,
};
