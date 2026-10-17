import { z } from 'zod';

import { judgeResponseSchema } from './rubric-prompt.js';

/** Portable token counts, kept when the selected provider reports them. */
const usageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
});

/** One provider attempt, kept so a retried structured response stays reproducible. */
const attemptSchema = z.object({
  rawResponse: z.json(),
  usage: usageSchema.optional(),
  error: z.string().optional(),
});

/**
 * Everything needed to reproduce one rubric call. Provider credentials are deliberately absent so
 * records stay safe to persist and render.
 */
const recordSchema = z.object({
  request: z.object({
    model: z.string(),
    system: z.string(),
    user: z.string(),
    params: z.record(z.string(), z.json()),
  }),
  rawResponse: z.json(),
  usage: usageSchema.optional(),
  attempts: z.array(attemptSchema),
});

/** Validates cached judge outcomes before they enter metric evaluation. */
const judgeOutcomeSchema = z.object({
  verdict: judgeResponseSchema,
  record: recordSchema,
});

type JudgeUsage = z.infer<typeof usageSchema>;

type JudgeAttempt = z.infer<typeof attemptSchema>;

type JudgeRecord = z.infer<typeof recordSchema>;

/** Couples the semantic verdict with its reproducibility evidence. */
type JudgeOutcome = z.infer<typeof judgeOutcomeSchema>;

export {
  judgeOutcomeSchema,
  type JudgeAttempt,
  type JudgeOutcome,
  type JudgeRecord,
  type JudgeUsage,
};
