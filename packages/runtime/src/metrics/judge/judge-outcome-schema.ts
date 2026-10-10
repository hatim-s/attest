import { z } from 'zod';

import type { JudgeOutcome } from './judge-client.js';
import { judgeResponseSchema } from './rubric-prompt.js';

const usageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
});

/** Validates cached judge outcomes before they enter metric evaluation. */
const judgeOutcomeSchema = z.object({
  verdict: judgeResponseSchema,
  record: z.object({
    request: z.object({
      model: z.string(),
      system: z.string(),
      user: z.string(),
      params: z.record(z.string(), z.json()),
    }),
    rawResponse: z.json(),
    usage: usageSchema.optional(),
    attempts: z.array(
      z.object({
        rawResponse: z.json(),
        usage: usageSchema.optional(),
        error: z.string().optional(),
      }),
    ),
  }),
}) satisfies z.ZodType<JudgeOutcome>;

export { judgeOutcomeSchema };
