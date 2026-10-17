import {
  agentRequestSchema,
  caseOutcomeSchema,
  invocationDiagnosticsSchema,
  invocationErrorCodeSchema,
  rawExcerptSchema,
  traceSchema,
  warningCodeSchema,
  type RawExcerpt,
} from '@attest/contracts';
import { z } from 'zod';

const isoTimestampSchema = z
  .string()
  .refine(
    (value) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) &&
      Number.isFinite(Date.parse(value)),
    'must be an ISO timestamp',
  );

const nonemptyStringSchema = z.string().min(1);

const durationSchema = z.number().finite().nonnegative();

const warningSchema = z.object({
  path: z.string(),
  message: z.string(),
  code: warningCodeSchema,
});

const attemptSchemaFor = (rawExcerpt: z.ZodType<RawExcerpt>) => {
  const attemptBase = {
    diagnostics: invocationDiagnosticsSchema,
    durationMs: durationSchema,
    rawExcerpt: rawExcerpt.optional(),
    warnings: z.array(warningSchema),
  };

  return z.discriminatedUnion('status', [
    z.strictObject({ ...attemptBase, status: z.literal('ok') }),
    z.strictObject({
      ...attemptBase,
      status: z.literal('invocation_error'),
      errorCode: invocationErrorCodeSchema,
      errorMessage: z.string(),
    }),
  ]);
};

const storedAttemptSchema = attemptSchemaFor(rawExcerptSchema);

// Read side only. Before "fix(executor): hash the received body on mapped HTTP cap overflow"
// (5f8a023), mapped HTTP cap overflow stored `truncated: true` with no sha256, and the digest of
// the dropped bytes cannot be rebuilt from the prefix. Dropping only the truncation refine admits
// that one shape so those runs stay readable; writes keep the strict schema. Remove this once the
// alpha databases written before that commit are gone.
const recordedAttemptSchema = attemptSchemaFor(z.strictObject(rawExcerptSchema.shape));

const executionBase = {
  caseId: nonemptyStringSchema,
  suiteName: nonemptyStringSchema,
  request: agentRequestSchema,
  startedAt: isoTimestampSchema,
  durationMs: durationSchema,
  warnings: z.array(warningSchema),
  diagnostics: invocationDiagnosticsSchema,
  attempts: z.array(storedAttemptSchema),
  expectedMetrics: z.array(z.string()),
};

const completedExecutionFields = {
  ...executionBase,
  outcome: z.literal('completed'),
  // Agent responses may hold optional undefined fields, so `z.json()` would reject typed input.
  response: z.unknown().refine((response) => response !== undefined, 'is required'),
  trace: traceSchema.optional(),
};

const failedExecutionFields = {
  ...executionBase,
  outcome: caseOutcomeSchema.exclude(['completed']),
  errorCode: invocationErrorCodeSchema,
  errorMessage: z.string(),
};

// Strict branches reject fields that belong to the other outcome, such as a response on a timeout.
const storedCaseExecutionSchema = z.discriminatedUnion('outcome', [
  z.strictObject(completedExecutionFields),
  z.strictObject(failedExecutionFields),
]);

const metricBase = {
  metricName: nonemptyStringSchema,
  kind: z.enum(['assertion', 'exec', 'judge']),
  rationale: z.string().optional(),
  details: z.json().optional(),
  judgeIo: z.json().optional(),
  durationMs: durationSchema.optional(),
};

const storedMetricEvaluationSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...metricBase,
    status: z.literal('evaluated'),
    score: z.number().finite(),
    pass: z.boolean(),
  }),
  z.strictObject({
    ...metricBase,
    status: z.literal('error'),
    error: z.object({ message: nonemptyStringSchema, kind: nonemptyStringSchema }),
  }),
]);

const summarySchema = z.object({
  totalCases: z.number().int().nonnegative(),
  passedCases: z.number().int().nonnegative(),
  failedCases: z.number().int().nonnegative(),
  errorCases: z.number().int().nonnegative(),
  metricErrorCount: z.number().int().nonnegative(),
});

const runMetadataSchema = z.object({
  schemaId: nonemptyStringSchema,
  configHash: nonemptyStringSchema,
  configJson: z.string(),
  gitSha: z.string().optional(),
  gitBranch: z.string().optional(),
  labels: z.record(z.string(), z.string()).optional(),
});

const runRecordSchema = runMetadataSchema
  .extend({
    id: nonemptyStringSchema,
    createdAt: isoTimestampSchema,
    finishedAt: isoTimestampSchema.optional(),
    status: z.enum(['running', 'completed', 'failed', 'cancelled']),
    summary: summarySchema.optional(),
  })
  .superRefine((run, context) => {
    if (run.status === 'running' && run.finishedAt !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['finishedAt'],
        message: 'is forbidden while running',
      });
    }

    if (run.status !== 'running' && run.finishedAt === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['finishedAt'],
        message: 'is required when terminal',
      });
    }
  });

const caseRecordFields = {
  rowId: nonemptyStringSchema,
  runId: nonemptyStringSchema,
  inputHash: nonemptyStringSchema,
  attempts: z.array(recordedAttemptSchema),
  metrics: z.array(storedMetricEvaluationSchema),
};

const caseRecordSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ ...completedExecutionFields, ...caseRecordFields }),
  z.strictObject({ ...failedExecutionFields, ...caseRecordFields }),
]);

type CaseRecord = z.infer<typeof caseRecordSchema>;

type RunMetadata = z.infer<typeof runMetadataSchema>;

type RunRecord = z.infer<typeof runRecordSchema>;

type RunSummary = z.infer<typeof summarySchema>;

type StoredAttempt = z.infer<typeof storedAttemptSchema>;

type StoredCaseExecution = z.infer<typeof storedCaseExecutionSchema>;

type StoredMetricEvaluation = z.infer<typeof storedMetricEvaluationSchema>;

export {
  caseRecordSchema,
  runMetadataSchema,
  runRecordSchema,
  storedCaseExecutionSchema,
  storedMetricEvaluationSchema,
  type CaseRecord,
  type RunMetadata,
  type RunRecord,
  type RunSummary,
  type StoredAttempt,
  type StoredCaseExecution,
  type StoredMetricEvaluation,
};
