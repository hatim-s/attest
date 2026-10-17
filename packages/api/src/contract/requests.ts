import { z } from 'zod';
import { pageQuerySchema as corePageQuerySchema } from '@attest/core/records';

const idSchema = z.string().min(1);

const runParamsSchema = z.object({ runId: idSchema });

const caseParamsSchema = z.object({ runId: idSchema, suiteName: idSchema, caseId: idSchema });

const diffParamsSchema = z
  .object({ baseRunId: idSchema, candidateRunId: idSchema })
  .refine((params) => params.baseRunId !== params.candidateRunId, {
    message: 'baseRunId and candidateRunId must differ.',
  });

const pageQuerySchema = corePageQuerySchema.extend({
  limit: z.coerce.number().optional().pipe(corePageQuerySchema.shape.limit),
});

export { runParamsSchema, caseParamsSchema, diffParamsSchema, pageQuerySchema };
