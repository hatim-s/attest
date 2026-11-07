import { stripStruct, looseStruct } from '@attest/contracts';
import {
  agentErrorSchema,
  agentRequestSchema,
  invocationDiagnosticsSchema,
  invocationErrorCodeSchema,
  inlineArtifactSchema,
  rawExcerptSchema,
  traceSchema,
  warningCodeSchema,
  type RawExcerpt,
} from '@attest/contracts';
import * as Schema from 'effect/Schema';
import { indexedTimestampSchema } from '../../records/dashboard-schemas.js';

const isoTimestampSchema = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) &&
      Number.isFinite(Date.parse(value)),
    { message: 'must be an ISO timestamp' },
  ),
);

const nonemptyStringSchema = Schema.String.check(Schema.isMinLength(1));

const durationSchema = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const warningSchema = stripStruct({
  path: Schema.String,
  message: Schema.String,
  code: warningCodeSchema,
});

const attemptSchemaFor = (rawExcerpt: Schema.ConstraintDecoder<RawExcerpt>) => {
  const attemptBase = {
    diagnostics: invocationDiagnosticsSchema,
    durationMs: durationSchema,
    rawExcerpt: Schema.optional(rawExcerpt),
    warnings: Schema.Array(warningSchema),
  };

  return Schema.Union([
    Schema.Struct({ ...attemptBase, status: Schema.Literal('ok') }),
    Schema.Struct({
      ...attemptBase,
      status: Schema.Literal('invocation_error'),
      errorCode: invocationErrorCodeSchema,
      errorMessage: Schema.String,
    }),
  ]);
};

const storedAttemptSchema = attemptSchemaFor(rawExcerptSchema);

// Read side only. Before "fix(executor): hash the received body on mapped HTTP cap overflow"
// (5f8a023), mapped HTTP cap overflow stored `truncated: true` with no sha256, and the digest of
// the dropped bytes cannot be rebuilt from the prefix. Dropping only the truncation refine admits
// that one shape so those runs stay readable; writes keep the strict schema. Remove this once the
// alpha databases written before that commit are gone.
const recordedAttemptSchema = attemptSchemaFor(Schema.Struct(rawExcerptSchema.fields));

const executionBase = {
  caseId: nonemptyStringSchema,
  suiteName: nonemptyStringSchema,
  request: agentRequestSchema,
  startedAt: isoTimestampSchema,
  durationMs: durationSchema,
  warnings: Schema.Array(warningSchema),
  diagnostics: invocationDiagnosticsSchema,
  attempts: Schema.Array(storedAttemptSchema),
  expectedMetrics: Schema.Array(Schema.String),
};

const completedExecutionFields = {
  ...executionBase,
  outcome: Schema.Literal('completed'),
  // Only error and artifacts are typed: verdicts read error, the dashboard lists artifacts, and the
  // rest of the envelope is opaque evidence.
  response: looseStruct({
    error: Schema.optional(agentErrorSchema),
    artifacts: Schema.optional(Schema.Array(inlineArtifactSchema)),
  }),
  trace: Schema.optional(traceSchema),
};

const failedExecutionFields = {
  ...executionBase,
  outcome: Schema.Literals(['invocation_error', 'timeout', 'cancelled']),
  errorCode: invocationErrorCodeSchema,
  errorMessage: Schema.String,
};

// Strict branches reject fields that belong to the other outcome, such as a response on a timeout.
const storedCaseExecutionSchema = Schema.Union([
  Schema.Struct(completedExecutionFields),
  Schema.Struct(failedExecutionFields),
]);

const metricBase = {
  metricName: nonemptyStringSchema,
  kind: Schema.Literals(['assertion', 'exec', 'judge']),
  rationale: Schema.optional(Schema.String),
  details: Schema.optional(Schema.Json),
  judgeIo: Schema.optional(Schema.Json),
  durationMs: Schema.optional(durationSchema),
};

const storedMetricEvaluationSchema = Schema.Union([
  Schema.Struct({
    ...metricBase,
    status: Schema.Literal('evaluated'),
    score: Schema.Finite,
    pass: Schema.Boolean,
  }),
  Schema.Struct({
    ...metricBase,
    status: Schema.Literal('error'),
    error: stripStruct({ message: nonemptyStringSchema, kind: nonemptyStringSchema }),
  }),
]);

const summarySchema = stripStruct({
  totalCases: Schema.Finite.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
  passedCases: Schema.Finite.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
  failedCases: Schema.Finite.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
  errorCases: Schema.Finite.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
  metricErrorCount: Schema.Finite.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
});

const runMetadataSchema = stripStruct({
  schemaId: nonemptyStringSchema,
  configHash: nonemptyStringSchema,
  configJson: Schema.String,
  gitSha: Schema.optional(Schema.String),
  gitBranch: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

const runRecordBaseSchema = stripStruct({
  ...runMetadataSchema.from.schema.fields,
  id: nonemptyStringSchema,
  createdAt: indexedTimestampSchema,
  summary: Schema.optional(summarySchema),
});

const runRecordSchema = Schema.Union([
  stripStruct({
    ...runRecordBaseSchema.from.schema.fields,
    status: Schema.Literal('running'),
    finishedAt: Schema.optional(Schema.Undefined),
  }),
  stripStruct({
    ...runRecordBaseSchema.from.schema.fields,
    status: Schema.Literals(['completed', 'failed', 'cancelled']),
    finishedAt: isoTimestampSchema,
  }),
]);

const caseRecordFields = {
  rowId: nonemptyStringSchema,
  runId: nonemptyStringSchema,
  inputHash: nonemptyStringSchema,
  attempts: Schema.Array(recordedAttemptSchema),
  metrics: Schema.Array(storedMetricEvaluationSchema),
};

const caseRecordSchema = Schema.Union([
  Schema.Struct({ ...completedExecutionFields, ...caseRecordFields }),
  Schema.Struct({ ...failedExecutionFields, ...caseRecordFields }),
]);

type CaseRecord = typeof caseRecordSchema.Type;

type RunMetadata = typeof runMetadataSchema.Type;

/** Status narrows lifecycle timestamps so terminal readers can rely on finishedAt. */
type RunRecord = typeof runRecordSchema.Type;

type RunSummary = typeof summarySchema.Type;

type StoredAttempt = typeof storedAttemptSchema.Type;

type StoredCaseExecution = typeof storedCaseExecutionSchema.Type;

type StoredMetricEvaluation = typeof storedMetricEvaluationSchema.Type;

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
