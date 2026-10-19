import { cliFailureResultSchema } from '@attest/contracts';
import { z } from 'zod';

/** One authored test a dashboard run can select. Tags are the union of its cases' tags. */
const testSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  tags: z.array(z.string().min(1)),
  caseCount: z.number().int().nonnegative(),
});

/**
 * The dashboard's request to start a run. It is not the CLI's `eval.run` document: the local host
 * maps it to one and the CLI validates that document again, so ids are only checked for shape here.
 */
const runStartRequestSchema = z.strictObject({
  selection: z.union([
    z.strictObject({ all: z.literal(true) }),
    z.strictObject({ testIds: z.array(z.string().min(1)).nonempty() }),
  ]),
  tags: z.array(z.string().min(1)).nonempty().optional(),
  concurrency: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const runCancelOutcomeSchema = z.enum([
  'cancellation_requested',
  'already_cancelled',
  'already_terminal',
]);

/** The CLI's own failure document for a run that did not start, without its retry policy. */
const runStartDiagnosticsSchema = cliFailureResultSchema.shape.error.omit({ retryable: true });

type TestSummary = z.infer<typeof testSummarySchema>;

type RunStartRequest = z.infer<typeof runStartRequestSchema>;

type RunCancelOutcome = z.infer<typeof runCancelOutcomeSchema>;

type RunStartDiagnostics = z.infer<typeof runStartDiagnosticsSchema>;

export {
  testSummarySchema,
  runStartRequestSchema,
  runCancelOutcomeSchema,
  runStartDiagnosticsSchema,
  type TestSummary,
  type RunStartRequest,
  type RunCancelOutcome,
  type RunStartDiagnostics,
};
