import {
  chat,
  StandardSchemaValidationError,
  type AnyTextAdapter,
  type ChatMiddleware,
} from '@tanstack/ai';
import { z } from 'zod';

import { judgeResponseSchema } from '../rubric-prompt.js';

/** SDK finalization codes for structured output the provider returned but that failed to parse. */
const UNPARSEABLE_RESPONSE_CODES = new Set([
  'structured-output-parse-failed',
  'structured-output-validation-failed',
  'structured-output-missing-result',
]);

const structuredOutputCompleteSchema = z.object({
  name: z.literal('structured-output.complete'),
  value: z.object({ raw: z.string() }),
});

/** Captures one provider attempt without conflating its evidence with an earlier structured-output retry. */
type JudgeAttemptObservation = {
  inputTokens: number;
  outputTokens: number;
  usageObserved: boolean;
  rawResponse: string | undefined;
};

/** Inputs for one schema-constrained chat call. */
type StructuredChatRequest = {
  adapter: AnyTextAdapter;
  system: string;
  user: string;
  signal: AbortSignal;
  observation: JudgeAttemptObservation;
};

/** Executes one schema-constrained chat call; injected by tests to avoid provider network calls. */
type StructuredChatExecutor = (request: StructuredChatRequest) => Promise<unknown>;

/** Identifies SDK structured-output failures that metric spec §3 permits retrying exactly once. */
const isUnparseableResponse = (error: unknown): boolean => {
  if (error instanceof StandardSchemaValidationError) {
    return true;
  }
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    UNPARSEABLE_RESPONSE_CODES.has(error.code)
  );
};

/** Captures one attempt's provider bytes and token deltas without exposing SDK objects to persistence. */
const createRecordMiddleware = (observation: JudgeAttemptObservation): ChatMiddleware => ({
  name: 'attest-judge-record',
  onChunk: (_context, chunk) => {
    if (chunk.type !== 'CUSTOM') {
      return;
    }
    const complete = structuredOutputCompleteSchema.safeParse(chunk);
    if (complete.success) {
      observation.rawResponse = complete.data.value.raw;
    }
  },
  onUsage: (_context, providerUsage) => {
    observation.usageObserved = true;
    observation.inputTokens += providerUsage.promptTokens;
    observation.outputTokens += providerUsage.completionTokens;
  },
});

/** Runs the real TanStack structured chat, forwarding the caller's signal to the SDK's controller. */
const executeStructuredChat: StructuredChatExecutor = async (request) => {
  const abortController = new AbortController();
  const forwardAbort = (): void => abortController.abort(request.signal.reason);
  if (request.signal.aborted) {
    forwardAbort();
  }
  request.signal.addEventListener('abort', forwardAbort, { once: true });
  try {
    return await chat({
      adapter: request.adapter,
      systemPrompts: [request.system],
      messages: [{ role: 'user', content: request.user }],
      outputSchema: judgeResponseSchema,
      stream: false,
      abortController,
      middleware: [createRecordMiddleware(request.observation)],
      debug: false,
    });
  } finally {
    request.signal.removeEventListener('abort', forwardAbort);
  }
};

export {
  executeStructuredChat,
  isUnparseableResponse,
  type JudgeAttemptObservation,
  type StructuredChatExecutor,
};
