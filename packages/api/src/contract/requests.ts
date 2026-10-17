import { z } from 'zod';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@attest/core/records';

const idSchema = z.string().min(1);

const runParamsSchema = z.object({ runId: idSchema });

const caseParamsSchema = z.object({ runId: idSchema, suiteName: idSchema, caseId: idSchema });

const diffParamsSchema = z
  .object({ baseRunId: idSchema, candidateRunId: idSchema })
  .refine((params) => params.baseRunId !== params.candidateRunId, {
    message: 'baseRunId and candidateRunId must differ.',
  });

const pageQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});

export { runParamsSchema, caseParamsSchema, diffParamsSchema, pageQuerySchema };
