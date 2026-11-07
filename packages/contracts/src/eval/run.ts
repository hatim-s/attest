import {
  ulidSchema,
  positiveIntegerSchema,
  nonnegativeIntegerSchema,
  timestampSchema,
} from '../schema/scalars.js';
import * as Schema from 'effect/Schema';

import { caseSelectionSchema, caseSelectionSummarySchema, testIdListSchema } from './selection.js';
import {
  durationMillisecondsSchema,
  projectIdSchema,
  resourceIdSchema,
  sha256Schema,
} from '../project/shared.js';
import { evalExecutionConfigSchema } from '../project/eval-execution.js';
import { COMMAND_REQUEST_SCHEMA_ID, EVAL_RUN_SCHEMA_ID } from '../schema/identifiers.js';

const evalOutputModeSchema = Schema.Literals(['human', 'json', 'jsonl']);

const evalRunIdSchema = ulidSchema;

const evalRunCommonRequestFields = {
  schema: Schema.Literal(COMMAND_REQUEST_SCHEMA_ID),
  command: Schema.Literal('eval.run'),
  ...caseSelectionSchema.fields,
  concurrency: Schema.optional(positiveIntegerSchema),
  timeout_ms: Schema.optional(durationMillisecondsSchema),
  baseline_run_id: Schema.optional(evalRunIdSchema),
  junit_path: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
};

const humanOutputFields = {
  output: Schema.Literal('human'),
  watch: Schema.optional(Schema.Boolean),
};

const structuredOutputFields = {
  output: Schema.Literals(['json', 'jsonl']),
};

/** Builds the explicit-tests and all-tests request branches for one output mode. */
const testScopeBranches = <OutputFields extends Schema.Struct.Fields>(outputFields: OutputFields) =>
  [
    Schema.Struct({
      ...evalRunCommonRequestFields,
      test_ids: testIdListSchema,
      ...outputFields,
    }),
    Schema.Struct({ ...evalRunCommonRequestFields, all: Schema.Literal(true), ...outputFields }),
  ] as const;

/**
 * Encodes the normalized `attest eval run` request produced by flags or JSON input.
 * Strict branches make test/all selection exclusive and keep watch out of structured output.
 */
const evalRunRequestSchema = Schema.Union([
  ...testScopeBranches(humanOutputFields),
  ...testScopeBranches(structuredOutputFields),
]);

const authoredResourceHashSchema = Schema.Struct({
  id: resourceIdSchema,
  content_hash: sha256Schema,
});

const datasetResourceHashSchema = Schema.Struct({
  id: resourceIdSchema,
  data_content_hash: sha256Schema,
  metadata_content_hash: sha256Schema,
});

const selectedCaseSourceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('direct') }),
  Schema.Struct({ kind: Schema.Literal('dataset'), dataset_id: resourceIdSchema }),
]);

/** Preserves configured order independently from concurrent completion order. */
const evalRunSelectedCaseSchema = Schema.Struct({
  configured_index: nonnegativeIntegerSchema,
  test_id: resourceIdSchema,
  case_id: resourceIdSchema,
  source: selectedCaseSourceSchema,
});

/** Freezes every content address and selected identity resolved before execution begins. */
const evalRunSnapshotSchema = Schema.Struct({
  project_id: projectIdSchema,
  project_hash: sha256Schema,
  resource_hashes: Schema.Struct({
    agents: Schema.Array(authoredResourceHashSchema),
    tests: Schema.Array(authoredResourceHashSchema),
    datasets: Schema.Array(datasetResourceHashSchema),
    metrics: Schema.Array(authoredResourceHashSchema),
  }),
  selected_test_ids: Schema.Array(resourceIdSchema).check(Schema.isMinLength(1)),
  selected_cases: Schema.Array(evalRunSelectedCaseSchema),
  selection: Schema.optional(caseSelectionSummarySchema),
}).check(
  Schema.makeFilter((snapshot) =>
    snapshot.selection === undefined ||
    snapshot.selection.selected_cases === snapshot.selected_cases.length
      ? undefined
      : 'Selection coverage must match the selected case list.',
  ),
);

/** Records the caller spelling and fully resolved execution values used for the immutable run. */
const evalRunEffectiveCommandSchema = Schema.Struct({
  command_path: Schema.Tuple([Schema.Literal('eval'), Schema.Literal('run')]),
  argv: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  request: evalRunRequestSchema,
  resolved: Schema.Struct({
    concurrency: positiveIntegerSchema,
    timeout_ms: durationMillisecondsSchema,
    output: evalOutputModeSchema,
    watch: Schema.Boolean,
    execution: Schema.optional(evalExecutionConfigSchema),
    baseline_run_id: Schema.optional(evalRunIdSchema),
    junit_path: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  }),
});

const evalRunGitMetadataSchema = Schema.Struct({
  commit: Schema.String.check(
    Schema.isPattern(/^[a-f0-9]{7,64}$/u, {
      message: 'must be a lowercase hexadecimal Git object id',
    }),
  ),
  branch: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  dirty: Schema.Boolean,
});

/**
 * Defines the immutable metadata persisted when an eval run is created.
 * Mutable lifecycle state and case results remain in the run store rather than changing this snapshot.
 */
const evalRunSchema = Schema.Struct({
  schema: Schema.Literal(EVAL_RUN_SCHEMA_ID),
  run_id: evalRunIdSchema,
  created_at: timestampSchema,
  snapshot_hash: sha256Schema,
  snapshot: evalRunSnapshotSchema,
  effective_command: evalRunEffectiveCommandSchema,
  git: Schema.optional(evalRunGitMetadataSchema),
});

type EvalOutputMode = typeof evalOutputModeSchema.Type;

type EvalRun = typeof evalRunSchema.Type;

type EvalRunEffectiveCommand = typeof evalRunEffectiveCommandSchema.Type;

type EvalRunRequest = typeof evalRunRequestSchema.Type;

type EvalRunSelectedCase = typeof evalRunSelectedCaseSchema.Type;

type EvalRunSnapshot = typeof evalRunSnapshotSchema.Type;

export {
  evalOutputModeSchema,
  evalRunEffectiveCommandSchema,
  evalRunIdSchema,
  evalRunRequestSchema,
  evalRunSchema,
  evalRunSelectedCaseSchema,
  evalRunSnapshotSchema,
  type EvalOutputMode,
  type EvalRun,
  type EvalRunEffectiveCommand,
  type EvalRunRequest,
  type EvalRunSelectedCase,
  type EvalRunSnapshot,
};
