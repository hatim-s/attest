import { z } from 'zod';
import { pageQuerySchema as corePageQuerySchema, projectKeySchema } from '@attest/core/records';

const idSchema = z.string().min(1);

const projectParamsSchema = z.object({ projectKey: projectKeySchema });

const runParamsSchema = projectParamsSchema.extend({ runId: idSchema });

const caseParamsSchema = runParamsSchema.extend({ suiteName: idSchema, caseId: idSchema });

const diffParamsSchema = projectParamsSchema
  .extend({ baseRunId: idSchema, candidateRunId: idSchema })
  .refine((params) => params.baseRunId !== params.candidateRunId, {
    message: 'baseRunId and candidateRunId must differ.',
  });

const pageQuerySchema = corePageQuerySchema.extend({
  limit: z.coerce.number().optional().pipe(corePageQuerySchema.shape.limit),
});

const suiteParamsSchema = projectParamsSchema.extend({ suiteName: idSchema });

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
  projectParamsSchema,
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
