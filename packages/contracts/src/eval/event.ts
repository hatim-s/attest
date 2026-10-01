import { z } from 'zod';

import { cliFailureResultSchema, cliSuccessResultSchema } from '../cli/protocol.js';
import { caseOutcomeSchema } from './execution.js';
import { evalRunIdSchema } from './run.js';
import { caseSelectionSummarySchema } from './selection.js';
import { resourceIdSchema, sha256Schema } from '../project/shared.js';
import { CLI_EVENT_SCHEMA_ID } from '../schema/identifiers.js';

const evalRunSummarySchema = z.strictObject({
  total_cases: z.number().int().nonnegative(),
  passed_cases: z.number().int().nonnegative(),
  failed_cases: z.number().int().nonnegative(),
  error_cases: z.number().int().nonnegative(),
  metric_error_count: z.number().int().nonnegative(),
});

const evalEventBaseFields = {
  schema: z.literal(CLI_EVENT_SCHEMA_ID),
  sequence: z.number().int().nonnegative(),
  time: z.iso.datetime({ offset: true }),
};

const evalRunStartedEventSchema = z.strictObject({
  ...evalEventBaseFields,
  event: z.literal('run_started'),
  data: z.strictObject({
    run_id: evalRunIdSchema,
    snapshot_hash: sha256Schema,
    selection: caseSelectionSummarySchema.optional(),
    total_cases: z.number().int().nonnegative(),
    concurrency: z.number().int().positive(),
    timeout_ms: z.number().int().positive(),
  }),
});

const evalCaseStartedEventSchema = z.strictObject({
  ...evalEventBaseFields,
  event: z.literal('case_started'),
  data: z.strictObject({
    run_id: evalRunIdSchema,
    test_id: resourceIdSchema,
    case_id: resourceIdSchema,
    configured_index: z.number().int().nonnegative(),
  }),
});

const evalCaseCompletedEventSchema = z.strictObject({
  ...evalEventBaseFields,
  event: z.literal('case_completed'),
  data: z.strictObject({
    run_id: evalRunIdSchema,
    test_id: resourceIdSchema,
    case_id: resourceIdSchema,
    configured_index: z.number().int().nonnegative(),
    completion_index: z.number().int().nonnegative(),
    outcome: caseOutcomeSchema,
    verdict: z.enum(['pass', 'fail', 'error']),
  }),
});

const evalRunCompletedEventSchema = z.strictObject({
  ...evalEventBaseFields,
  event: z.literal('run_completed'),
  data: z.strictObject({
    run_id: evalRunIdSchema,
    status: z.enum(['completed', 'failed', 'cancelled']),
    summary: evalRunSummarySchema,
  }),
});

const evalRunResultPayloadFields = {
  run_id: evalRunIdSchema,
  snapshot_hash: sha256Schema,
  status: z.literal('completed'),
  summary: evalRunSummarySchema,
  selection: caseSelectionSummarySchema.optional(),
  baseline_run_id: evalRunIdSchema.optional(),
  junit_path: z.string().min(1).optional(),
};

const passingEvalRunResultSchema = cliSuccessResultSchema.extend({
  command: z.literal('eval.run'),
  result: z.strictObject({ ...evalRunResultPayloadFields, verdict: z.literal('pass') }),
});

const failingEvalRunResultSchema = cliSuccessResultSchema.extend({
  command: z.literal('eval.run'),
  result: z.strictObject({ ...evalRunResultPayloadFields, verdict: z.literal('fail') }),
});

const failedEvalRunResultSchema = cliFailureResultSchema.extend({
  command: z.literal('eval.run'),
});

/** Binds every stable process exit to the shared result-envelope variant. */
const evalFinalResultDataSchema = z.union([
  z.strictObject({ exit_code: z.literal(0), result: passingEvalRunResultSchema }),
  z.strictObject({ exit_code: z.literal(1), result: failingEvalRunResultSchema }),
  // Exit 1 also covers user-data validation that fails before an eval run is created.
  z.strictObject({ exit_code: z.literal([1, 2, 3, 4, 130]), result: failedEvalRunResultSchema }),
]);

const evalResultEventSchema = z.strictObject({
  ...evalEventBaseFields,
  event: z.literal('result'),
  data: evalFinalResultDataSchema,
});

/** Narrows `attest.cli-event` to the append-only eval orchestration vocabulary. */
const evalEventSchema = z.discriminatedUnion('event', [
  evalRunStartedEventSchema,
  evalCaseStartedEventSchema,
  evalCaseCompletedEventSchema,
  evalRunCompletedEventSchema,
  evalResultEventSchema,
]);

type EvalEvent = z.infer<typeof evalEventSchema>;
type EvalFinalResultData = z.infer<typeof evalFinalResultDataSchema>;
type EvalRunSummary = z.infer<typeof evalRunSummarySchema>;

export {
  evalCaseCompletedEventSchema,
  evalCaseStartedEventSchema,
  evalEventSchema,
  evalFinalResultDataSchema,
  evalResultEventSchema,
  evalRunCompletedEventSchema,
  evalRunStartedEventSchema,
  evalRunSummarySchema,
  type EvalEvent,
  type EvalFinalResultData,
  type EvalRunSummary,
};
