import { z } from 'zod';

import {
  durationMillisecondsSchema,
  projectIdSchema,
  resourceIdSchema,
  sha256Schema,
} from '../project/shared.js';
import { COMMAND_REQUEST_SCHEMA_ID, EVAL_RUN_SCHEMA_ID } from '../schema/identifiers.js';

const evalOutputModeSchema = z.enum(['human', 'json', 'jsonl']);
const evalRunIdSchema = z.ulid();

const evalRunCommonRequestFields = {
  schema: z.literal(COMMAND_REQUEST_SCHEMA_ID),
  command: z.literal('eval.run'),
  case_ids: z.array(resourceIdSchema).nonempty().optional(),
  tags: z.array(z.string().min(1)).nonempty().optional(),
  concurrency: z.number().int().positive().optional(),
  timeout_ms: durationMillisecondsSchema.optional(),
  baseline_run_id: evalRunIdSchema.optional(),
  junit_path: z.string().min(1).optional(),
};

const selectedTestsFields = {
  test_ids: z.array(resourceIdSchema).nonempty(),
};

const allTestsFields = {
  all: z.literal(true),
};

const humanOutputFields = {
  output: z.literal('human'),
  watch: z.boolean().optional(),
};

const structuredOutputFields = {
  output: z.enum(['json', 'jsonl']),
};

/**
 * Encodes the normalized `attest eval run` request produced by flags or JSON input.
 * Separate strict branches make test/all selection exclusive and keep watch out of structured output.
 */
const evalRunRequestSchema = z.union([
  z.strictObject({
    ...evalRunCommonRequestFields,
    ...selectedTestsFields,
    ...humanOutputFields,
  }),
  z.strictObject({
    ...evalRunCommonRequestFields,
    ...selectedTestsFields,
    ...structuredOutputFields,
  }),
  z.strictObject({
    ...evalRunCommonRequestFields,
    ...allTestsFields,
    ...humanOutputFields,
  }),
  z.strictObject({
    ...evalRunCommonRequestFields,
    ...allTestsFields,
    ...structuredOutputFields,
  }),
]);

const authoredResourceHashSchema = z.strictObject({
  id: resourceIdSchema,
  content_hash: sha256Schema,
});

const datasetResourceHashSchema = z.strictObject({
  id: resourceIdSchema,
  data_content_hash: sha256Schema,
  metadata_content_hash: sha256Schema,
});

const selectedCaseSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('direct') }),
  z.strictObject({ kind: z.literal('dataset'), dataset_id: resourceIdSchema }),
]);

/** Preserves configured order independently from concurrent completion order. */
const evalRunSelectedCaseSchema = z.strictObject({
  configured_index: z.number().int().nonnegative(),
  test_id: resourceIdSchema,
  case_id: resourceIdSchema,
  source: selectedCaseSourceSchema,
});

/** Freezes every content address and selected identity resolved before execution begins. */
const evalRunSnapshotSchema = z.strictObject({
  project_id: projectIdSchema,
  project_hash: sha256Schema,
  resource_hashes: z.strictObject({
    agents: z.array(authoredResourceHashSchema),
    tests: z.array(authoredResourceHashSchema),
    datasets: z.array(datasetResourceHashSchema),
    metrics: z.array(authoredResourceHashSchema),
  }),
  selected_test_ids: z.array(resourceIdSchema).nonempty(),
  selected_cases: z.array(evalRunSelectedCaseSchema),
});

/** Records the caller spelling and fully resolved execution values used for the immutable run. */
const evalRunEffectiveCommandSchema = z.strictObject({
  command_path: z.tuple([z.literal('eval'), z.literal('run')]),
  argv: z.array(z.string()).nonempty(),
  request: evalRunRequestSchema,
  resolved: z.strictObject({
    concurrency: z.number().int().positive(),
    timeout_ms: durationMillisecondsSchema,
    output: evalOutputModeSchema,
    watch: z.boolean(),
    baseline_run_id: evalRunIdSchema.optional(),
    junit_path: z.string().min(1).optional(),
  }),
});

const evalRunGitMetadataSchema = z.strictObject({
  commit: z.string().regex(/^[a-f0-9]{7,64}$/u, 'must be a lowercase hexadecimal Git object id'),
  branch: z.string().min(1).optional(),
  dirty: z.boolean(),
});

/**
 * Defines the immutable metadata persisted when an eval run is created.
 * Mutable lifecycle state and case results remain in the run store rather than changing this snapshot.
 */
const evalRunSchema = z.strictObject({
  schema: z.literal(EVAL_RUN_SCHEMA_ID),
  run_id: evalRunIdSchema,
  created_at: z.iso.datetime({ offset: true }),
  snapshot_hash: sha256Schema,
  snapshot: evalRunSnapshotSchema,
  effective_command: evalRunEffectiveCommandSchema,
  git: evalRunGitMetadataSchema.optional(),
});

type EvalOutputMode = z.infer<typeof evalOutputModeSchema>;
type EvalRun = z.infer<typeof evalRunSchema>;
type EvalRunEffectiveCommand = z.infer<typeof evalRunEffectiveCommandSchema>;
type EvalRunRequest = z.infer<typeof evalRunRequestSchema>;
type EvalRunSelectedCase = z.infer<typeof evalRunSelectedCaseSchema>;
type EvalRunSnapshot = z.infer<typeof evalRunSnapshotSchema>;

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
