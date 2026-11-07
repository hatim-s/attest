import {
  positiveIntegerSchema,
  nonnegativeIntegerSchema,
  timestampSchema,
} from '../schema/scalars.js';
import * as Schema from 'effect/Schema';

import { cliFailureResultSchema, cliSuccessResultSchema } from '../cli/protocol.js';
import { caseOutcomeSchema } from './execution.js';
import { evalRunIdSchema } from './run.js';
import { caseSelectionSummarySchema } from './selection.js';
import { resourceIdSchema, sha256Schema } from '../project/shared.js';
import { CLI_EVENT_SCHEMA_ID } from '../schema/identifiers.js';

const evalRunSummarySchema = Schema.Struct({
  total_cases: nonnegativeIntegerSchema,
  passed_cases: nonnegativeIntegerSchema,
  failed_cases: nonnegativeIntegerSchema,
  error_cases: nonnegativeIntegerSchema,
  metric_error_count: nonnegativeIntegerSchema,
});

const evalEventBaseFields = {
  schema: Schema.Literal(CLI_EVENT_SCHEMA_ID),
  sequence: nonnegativeIntegerSchema,
  time: timestampSchema,
};

const evalRunStartedEventSchema = Schema.Struct({
  ...evalEventBaseFields,
  event: Schema.Literal('run_started'),
  data: Schema.Struct({
    run_id: evalRunIdSchema,
    snapshot_hash: sha256Schema,
    selection: Schema.optional(caseSelectionSummarySchema),
    total_cases: nonnegativeIntegerSchema,
    concurrency: positiveIntegerSchema,
    timeout_ms: positiveIntegerSchema,
  }),
});

const evalCaseStartedEventSchema = Schema.Struct({
  ...evalEventBaseFields,
  event: Schema.Literal('case_started'),
  data: Schema.Struct({
    run_id: evalRunIdSchema,
    test_id: resourceIdSchema,
    case_id: resourceIdSchema,
    configured_index: nonnegativeIntegerSchema,
  }),
});

const evalCaseCompletedEventSchema = Schema.Struct({
  ...evalEventBaseFields,
  event: Schema.Literal('case_completed'),
  data: Schema.Struct({
    run_id: evalRunIdSchema,
    test_id: resourceIdSchema,
    case_id: resourceIdSchema,
    configured_index: nonnegativeIntegerSchema,
    completion_index: nonnegativeIntegerSchema,
    outcome: caseOutcomeSchema,
    verdict: Schema.Literals(['pass', 'fail', 'error']),
  }),
});

const evalRunCompletedEventSchema = Schema.Struct({
  ...evalEventBaseFields,
  event: Schema.Literal('run_completed'),
  data: Schema.Struct({
    run_id: evalRunIdSchema,
    status: Schema.Literals(['completed', 'failed', 'cancelled']),
    summary: evalRunSummarySchema,
  }),
});

const evalRunResultPayloadFields = {
  run_id: evalRunIdSchema,
  snapshot_hash: sha256Schema,
  status: Schema.Literal('completed'),
  summary: evalRunSummarySchema,
  selection: Schema.optional(caseSelectionSummarySchema),
  baseline_run_id: Schema.optional(evalRunIdSchema),
  junit_path: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
};

const passingEvalRunResultSchema = Schema.Struct({
  ...cliSuccessResultSchema.fields,
  command: Schema.Literal('eval.run'),
  result: Schema.Struct({ ...evalRunResultPayloadFields, verdict: Schema.Literal('pass') }),
});

const failingEvalRunResultSchema = Schema.Struct({
  ...cliSuccessResultSchema.fields,
  command: Schema.Literal('eval.run'),
  result: Schema.Struct({ ...evalRunResultPayloadFields, verdict: Schema.Literal('fail') }),
});

const failedEvalRunResultSchema = Schema.Struct({
  ...cliFailureResultSchema.fields,
  command: Schema.Literal('eval.run'),
});

/** Binds every stable process exit to the shared result-envelope variant. */
const evalFinalResultDataSchema = Schema.Union([
  Schema.Struct({ exit_code: Schema.Literal(0), result: passingEvalRunResultSchema }),
  Schema.Struct({ exit_code: Schema.Literal(1), result: failingEvalRunResultSchema }),
  // Exit 1 also covers user-data validation that fails before an eval run is created.
  Schema.Struct({
    exit_code: Schema.Literals([1, 2, 3, 4, 130]),
    result: failedEvalRunResultSchema,
  }),
]);

const evalResultEventSchema = Schema.Struct({
  ...evalEventBaseFields,
  event: Schema.Literal('result'),
  data: evalFinalResultDataSchema,
});

/** Narrows `attest.cli-event` to the append-only eval orchestration vocabulary. */
const evalEventSchema = Schema.Union([
  evalRunStartedEventSchema,
  evalCaseStartedEventSchema,
  evalCaseCompletedEventSchema,
  evalRunCompletedEventSchema,
  evalResultEventSchema,
]);

type EvalEvent = typeof evalEventSchema.Type;

type EvalFinalResultData = typeof evalFinalResultDataSchema.Type;

type EvalRunSummary = typeof evalRunSummarySchema.Type;

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
