import {
  caseSelectionSchema,
  cliFailureResultSchema,
  durationMillisecondsSchema,
  testIdListSchema,
} from '@attest/contracts';
import { z } from 'zod';

/** One authored test a dashboard run can select. Tags are the union of its cases' tags. */
const testSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  tags: z.array(z.string().min(1)),
  caseCount: z.number().int().nonnegative(),
});

/**
 * The dashboard's request to start a run. It is not the CLI's `eval.run` document, but the local
 * host maps it to one field for field, so each field reuses the CLI's own rule and a request the
 * CLI would refuse is refused here, before a process is spawned.
 */
const runStartRequestSchema = z.strictObject({
  selection: z.union([
    z.strictObject({ all: z.literal(true) }),
    z.strictObject({ testIds: testIdListSchema }),
  ]),
  tags: caseSelectionSchema.shape.tags,
  concurrency: z.number().int().positive().optional(),
  timeoutMs: durationMillisecondsSchema.optional(),
});

const runCancelOutcomeSchema = z.enum([
  'cancellation_requested',
  'already_cancelled',
  'already_terminal',
]);

/**
 * The CLI's failure document, for a run that did not start or a project that does not load. A
 * failure the CLI reported carries its retry policy; one the host found itself leaves it unset.
 */
const cliDiagnosticsSchema = cliFailureResultSchema.shape.error.partial({ retryable: true });

type TestSummary = z.infer<typeof testSummarySchema>;

type RunStartRequest = z.infer<typeof runStartRequestSchema>;

type RunCancelOutcome = z.infer<typeof runCancelOutcomeSchema>;

type CliDiagnostics = z.infer<typeof cliDiagnosticsSchema>;

export {
  testSummarySchema,
  runStartRequestSchema,
  runCancelOutcomeSchema,
  cliDiagnosticsSchema,
  type TestSummary,
  type RunStartRequest,
  type RunCancelOutcome,
  type CliDiagnostics,
};
