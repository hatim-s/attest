import * as Effect from 'effect/Effect';
import { foreign, ownOperation, withRelease } from '../../internal/operation.js';
import { stripStruct } from '@attest/contracts';
import { parseWithSchema, parseWithSchemaSync } from '@attest/contracts';
import type { JsonValue } from '@attest/contracts';
import {
  chat,
  StandardSchemaValidationError,
  type AnyTextAdapter,
  type ChatMiddleware,
} from '@tanstack/ai';
import * as Schema from 'effect/Schema';

import { judgeResponseSchema } from '../rubric-prompt.js';

/** Adapts the verdict owner for SDK validation and provider JSON Schema generation. */
const nativeJudgeOutputSchema = Schema.toStandardJSONSchemaV1(
  Schema.toStandardSchemaV1(judgeResponseSchema, {
    parseOptions: { onExcessProperty: 'error', errors: 'all' },
  }),
);

// Effect's Standard JSON Schema converter defaults to allowing excess keys. The verdict has
// only scalar fields, so closing its root aligns provider JSON with the strict owner decoder.
const judgeOutputSchema = {
  '~standard': {
    ...nativeJudgeOutputSchema['~standard'],
    jsonSchema: {
      input: (options) => ({
        ...nativeJudgeOutputSchema['~standard'].jsonSchema.input(options),
        additionalProperties: false,
      }),
      output: (options) => ({
        ...nativeJudgeOutputSchema['~standard'].jsonSchema.output(options),
        additionalProperties: false,
      }),
    } satisfies (typeof nativeJudgeOutputSchema)['~standard']['jsonSchema'],
  },
};

/** SDK finalization errors for structured output the provider returned but that failed to parse. */
const unparseableResponseSchema = stripStruct({
  code: Schema.Literals([
    'structured-output-parse-failed',
    'structured-output-validation-failed',
    'structured-output-missing-result',
  ]),
});

const structuredOutputCompleteSchema = stripStruct({
  name: Schema.Literal('structured-output.complete'),
  value: stripStruct({ raw: Schema.String }),
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
type StructuredChatExecutor = (request: StructuredChatRequest) => Effect.Effect<JsonValue, Error>;

/** Identifies SDK structured-output failures the metric contract permits retrying exactly once. */
// BOUNDARY: SDK thrown values may carry a structured-output failure code.
const isUnparseableResponse = (cause: unknown): boolean =>
  cause instanceof StandardSchemaValidationError ||
  parseWithSchema(unparseableResponseSchema, cause).ok;

/** Captures one attempt's provider bytes and token deltas without exposing SDK objects to persistence. */
const createRecordMiddleware = (observation: JudgeAttemptObservation): ChatMiddleware => ({
  name: 'attest-judge-record',
  onChunk: (_context, chunk) => {
    if (chunk.type !== 'CUSTOM') {
      return;
    }

    const complete = parseWithSchema(structuredOutputCompleteSchema, chunk);

    if (complete.ok) {
      observation.rawResponse = complete.value.value.raw;
    }
  },
  onUsage: (_context, providerUsage) => {
    observation.usageObserved = true;
    observation.inputTokens += providerUsage.promptTokens;
    observation.outputTokens += providerUsage.completionTokens;
  },
});

/** Runs the real TanStack structured chat, forwarding the caller's signal to the SDK's controller. */
const executeStructuredChat: StructuredChatExecutor = (request) =>
  ownOperation((cancelled) =>
    Effect.gen(function* () {
      const abortController = new AbortController();
      const signal = AbortSignal.any([cancelled, request.signal]);
      const forwardAbort = (): void => abortController.abort(signal.reason);

      if (signal.aborted) {
        forwardAbort();
      }

      signal.addEventListener('abort', forwardAbort, { once: true });

      return yield* withRelease(
        Effect.gen(function* () {
          const response = yield* foreign(() =>
            chat({
              adapter: request.adapter,
              systemPrompts: [request.system],
              messages: [{ role: 'user', content: request.user }],
              outputSchema: judgeOutputSchema,
              stream: false,
              abortController,
              middleware: [createRecordMiddleware(request.observation)],
              debug: false,
            }),
          );

          return parseWithSchemaSync(Schema.Json, response);
        }),
        Effect.sync(() => signal.removeEventListener('abort', forwardAbort)),
      );
    }),
  );

export {
  executeStructuredChat,
  judgeOutputSchema,
  isUnparseableResponse,
  type JudgeAttemptObservation,
  type StructuredChatExecutor,
};
