import { agentRequestSchema, traceSchema } from '@attest/contracts';
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
const forbiddenValueSchema = z.custom<never>(() => true);
const invocationErrorCodeSchema = z.enum([
  'spawn_failed',
  'timeout',
  'output_cap_exceeded',
  'nonzero_exit',
  'http_status',
  'network',
  'invalid_envelope',
  'cancelled',
]);
const warningSchema = z.object({
  path: z.string(),
  message: z.string(),
  code: z.enum(['unknown_field', 'invalid_trace']),
});
const rawExcerptSchema = z.object({
  text: z.string(),
  truncated: z.boolean(),
  sha256: z.string().optional(),
});
const diagnosticsSchema = z.object({
  stderrExcerpt: z.string().optional(),
  exitCode: z.number().int().optional(),
  httpStatus: z.number().int().optional(),
  remoteJobId: z.union([z.string(), z.number().finite()]).optional(),
  unreapedProcessIds: z.array(z.number().int().positive().safe()).optional(),
});
const attemptBase = {
  diagnostics: diagnosticsSchema,
  durationMs: durationSchema,
  rawExcerpt: rawExcerptSchema.optional(),
  warnings: z.array(warningSchema),
};
const storedAttemptSchema = z
  .discriminatedUnion('status', [
    z.object({
      ...attemptBase,
      status: z.literal('ok'),
      errorCode: forbiddenValueSchema.optional(),
      errorMessage: forbiddenValueSchema.optional(),
    }),
    z.object({
      ...attemptBase,
      status: z.literal('invocation_error'),
      errorCode: invocationErrorCodeSchema,
      errorMessage: z.string(),
    }),
  ])
  .superRefine((attempt, context) => {
    if (attempt.status !== 'ok') return;
    for (const field of ['errorCode', 'errorMessage'] as const) {
      if (Object.hasOwn(attempt, field)) {
        context.addIssue({ code: 'custom', path: [field], message: `ok status forbids ${field}` });
      }
    }
  });
const executionBase = {
  caseId: nonemptyStringSchema,
  suiteName: nonemptyStringSchema,
  request: agentRequestSchema,
  startedAt: isoTimestampSchema,
  durationMs: durationSchema,
  warnings: z.array(warningSchema),
  diagnostics: diagnosticsSchema,
  attempts: z.array(storedAttemptSchema),
  expectedMetrics: z.array(z.string()),
};
const completedExecutionSchema = z.object({
  ...executionBase,
  outcome: z.literal('completed'),
  response: z.unknown(),
  trace: traceSchema.optional(),
  errorCode: forbiddenValueSchema.optional(),
  errorMessage: forbiddenValueSchema.optional(),
});
const failedExecutionSchema = z.object({
  ...executionBase,
  outcome: z.enum(['invocation_error', 'timeout', 'cancelled']),
  errorCode: invocationErrorCodeSchema,
  errorMessage: z.string(),
  response: forbiddenValueSchema.optional(),
  trace: forbiddenValueSchema.optional(),
});
const storedCaseExecutionSchema = z
  .discriminatedUnion('outcome', [completedExecutionSchema, failedExecutionSchema])
  .superRefine((execution, context) => {
    if (execution.outcome === 'completed') {
      if (!Object.hasOwn(execution, 'response') || execution.response === undefined) {
        context.addIssue({ code: 'custom', path: ['response'], message: 'is required' });
      }
      for (const field of ['errorCode', 'errorMessage'] as const) {
        if (Object.hasOwn(execution, field)) {
          context.addIssue({
            code: 'custom',
            path: [field],
            message: `with completed outcome forbids ${field}`,
          });
        }
      }
      return;
    }
    for (const field of ['response', 'trace'] as const) {
      if (Object.hasOwn(execution, field)) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `with non-completed outcome forbids ${field}`,
        });
      }
    }
  });

const metricBase = {
  metricName: nonemptyStringSchema,
  kind: z.enum(['assertion', 'exec', 'judge']),
  rationale: z.string().optional(),
  details: z.json().optional(),
  judgeIo: z.json().optional(),
  durationMs: durationSchema.optional(),
};
const storedMetricEvaluationSchema = z
  .discriminatedUnion('status', [
    z.object({
      ...metricBase,
      status: z.literal('evaluated'),
      score: z.number().finite(),
      pass: z.boolean(),
      error: forbiddenValueSchema.optional(),
    }),
    z.object({
      ...metricBase,
      status: z.literal('error'),
      error: z.object({ message: nonemptyStringSchema, kind: nonemptyStringSchema }),
      score: forbiddenValueSchema.optional(),
      pass: forbiddenValueSchema.optional(),
    }),
  ])
  .superRefine((evaluation, context) => {
    const forbidden = evaluation.status === 'evaluated' ? ['error'] : ['score', 'pass'];
    for (const field of forbidden) {
      if (Object.hasOwn(evaluation, field)) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `with ${evaluation.status} status forbids ${field}`,
        });
      }
    }
  });

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

const caseRecordSchema = z.intersection(
  storedCaseExecutionSchema,
  z.object({
    rowId: nonemptyStringSchema,
    runId: nonemptyStringSchema,
    inputHash: nonemptyStringSchema,
    metrics: z.array(storedMetricEvaluationSchema),
  }),
);

type CaseRecord = z.infer<typeof caseRecordSchema>;
type CanonicalRunMetadata = z.infer<typeof runMetadataSchema>;
type RunMetadata =
  CanonicalRunMetadata | (Omit<CanonicalRunMetadata, 'schemaId'> & { configVersion: string });
type RunRecord = z.infer<typeof runRecordSchema> & { readonly configVersion?: string };
type RunSummary = z.infer<typeof summarySchema>;
type StoredAttempt = z.infer<typeof storedAttemptSchema>;
type StoredCaseExecution = z.infer<typeof storedCaseExecutionSchema>;
type StoredDiagnostics = z.infer<typeof diagnosticsSchema>;
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
  type StoredDiagnostics,
  type StoredMetricEvaluation,
};
