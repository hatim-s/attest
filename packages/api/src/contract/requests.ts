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

const suiteParamsSchema = z.object({ suiteName: idSchema });

const MAX_SUITE_HISTORY_RUNS = 50;

const DEFAULT_SUITE_HISTORY_RUNS = 20;

const suiteHistoryQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_SUITE_HISTORY_RUNS)
    .default(DEFAULT_SUITE_HISTORY_RUNS),
});

const suiteHistoryRequestSchema = suiteParamsSchema.extend(suiteHistoryQuerySchema.shape);

type SuiteHistoryQuery = Partial<z.output<typeof suiteHistoryQuerySchema>>;

export {
  runParamsSchema,
  caseParamsSchema,
  diffParamsSchema,
  pageQuerySchema,
  suiteParamsSchema,
  suiteHistoryQuerySchema,
  suiteHistoryRequestSchema,
  MAX_SUITE_HISTORY_RUNS,
  DEFAULT_SUITE_HISTORY_RUNS,
  type SuiteHistoryQuery,
};
