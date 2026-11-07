import { stripStruct } from '@attest/contracts';
import * as Schema from 'effect/Schema';

import { judgeResponseSchema } from './rubric-prompt.js';

/** Portable token counts, kept when the selected provider reports them. */
const usageSchema = stripStruct({
  inputTokens: Schema.optional(Schema.Finite),
  outputTokens: Schema.optional(Schema.Finite),
});

/** One provider attempt, kept so a retried structured response stays reproducible. */
const attemptSchema = stripStruct({
  rawResponse: Schema.Json,
  usage: Schema.optional(usageSchema),
  error: Schema.optional(Schema.String),
});

/**
 * Everything needed to reproduce one rubric call. Provider credentials are deliberately absent so
 * records stay safe to persist and render.
 */
const recordSchema = stripStruct({
  request: stripStruct({
    model: Schema.String,
    system: Schema.String,
    user: Schema.String,
    params: Schema.Record(Schema.String, Schema.Json),
  }),
  rawResponse: Schema.Json,
  usage: Schema.optional(usageSchema),
  attempts: Schema.Array(attemptSchema),
});

/** Validates cached judge outcomes before they enter metric evaluation. */
const judgeOutcomeSchema = stripStruct({
  verdict: judgeResponseSchema,
  record: recordSchema,
});

type JudgeUsage = typeof usageSchema.Type;

type JudgeAttempt = typeof attemptSchema.Type;

type JudgeRecord = typeof recordSchema.Type;

/** Couples the semantic verdict with its reproducibility evidence. */
type JudgeOutcome = typeof judgeOutcomeSchema.Type;

export {
  judgeOutcomeSchema,
  type JudgeAttempt,
  type JudgeOutcome,
  type JudgeRecord,
  type JudgeUsage,
};
