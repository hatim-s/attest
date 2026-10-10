import type { JsonValue } from '@attest/contracts';
import { isString } from '@attest/contracts';
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
type StructuredChatExecutor = (request: StructuredChatRequest) => Promise<JsonValue>;

// BOUNDARY: SDK thrown values may expose a failure code; only object containers are inspected.
const isErrorRecord = (cause: unknown): cause is Record<string, unknown> =>
  cause !== null && typeof cause === 'object';

/** Identifies SDK structured-output failures that metric spec §3 permits retrying exactly once. */
const isUnparseableResponse = (cause: unknown): boolean => {
  if (cause instanceof StandardSchemaValidationError) {
    return true;
  }

  return (
    isErrorRecord(cause) &&
    cause !== null &&
    'code' in cause &&
    isString(cause.code) &&
    UNPARSEABLE_RESPONSE_CODES.has(cause.code)
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
    const response = await chat({
      adapter: request.adapter,
      systemPrompts: [request.system],
      messages: [{ role: 'user', content: request.user }],
      outputSchema: judgeResponseSchema,
      stream: false,
      abortController,
      middleware: [createRecordMiddleware(request.observation)],
      debug: false,
    });

    return z.json().parse(response);
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
