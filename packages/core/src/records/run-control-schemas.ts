import { stripStruct } from '@attest/contracts';
import {
  caseSelectionSchema,
  cliFailureResultSchema,
  durationMillisecondsSchema,
  testIdListSchema,
} from '@attest/contracts';
import * as Schema from 'effect/Schema';

/** One authored test a dashboard run can select. Tags are the union of its cases' tags. */
const testSummarySchema = stripStruct({
  id: Schema.String.check(Schema.isMinLength(1)),
  name: Schema.String.check(Schema.isMinLength(1)),
  tags: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
  caseCount: Schema.Finite.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
});

/**
 * The dashboard's request to start a run. It is not the CLI's `eval.run` document, but the local
 * host maps it to one field for field, so each field reuses the CLI's own rule and a request the
 * CLI would refuse is refused here, before a process is spawned.
 */
const runStartRequestSchema = Schema.Struct({
  selection: Schema.Union([
    Schema.Struct({ all: Schema.Literal(true) }),
    Schema.Struct({ testIds: testIdListSchema }),
  ]),
  tags: caseSelectionSchema.fields.tags,
  concurrency: Schema.optional(Schema.Finite.check(Schema.isInt()).check(Schema.isGreaterThan(0))),
  timeoutMs: Schema.optional(durationMillisecondsSchema),
});

const runCancelOutcomeSchema = Schema.Literals([
  'cancellation_requested',
  'already_cancelled',
  'already_terminal',
]);

/**
 * The CLI's failure document, for a run that did not start or a project that does not load. A
 * failure the CLI reported carries its retry policy; one the host found itself leaves it unset.
 */
const cliDiagnosticsSchema = Schema.Struct({
  ...cliFailureResultSchema.fields.error.fields,
  retryable: Schema.optional(cliFailureResultSchema.fields.error.fields.retryable),
});

type TestSummary = typeof testSummarySchema.Type;

type RunStartRequest = typeof runStartRequestSchema.Type;

type RunCancelOutcome = typeof runCancelOutcomeSchema.Type;

type CliDiagnostics = typeof cliDiagnosticsSchema.Type;

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
