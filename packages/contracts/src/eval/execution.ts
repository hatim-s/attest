import { safeIntegerSchema, positiveIntegerSchema } from '../schema/scalars.js';
import { stripStruct } from '../schema/objects.js';
import * as Schema from 'effect/Schema';

/**
 * Terminal classification of one executed case. The runner produces it and the store persists
 * it, so both read the same enum.
 */
const caseOutcomeSchema = Schema.Literals([
  'completed',
  'invocation_error',
  'timeout',
  'cancelled',
]);

/**
 * Every way an agent invocation can fail before producing an evaluable envelope
 * (docs/specs/agent-contract.md, execution semantics). The store persists these values verbatim,
 * so they are append-only within a contract version.
 */
const invocationErrorCodeSchema = Schema.Literals([
  'spawn_failed',
  'timeout',
  'output_cap_exceeded',
  'nonzero_exit',
  'http_status',
  'network',
  'invalid_envelope',
  'cancelled',
]);

/** Recoverable problems reported alongside a successfully parsed agent response. */
const warningCodeSchema = Schema.Literals(['unknown_field', 'invalid_trace']);

/**
 * Transport metadata recorded per invocation attempt and per case. Free-text failures are capped
 * so a hostile hook or sandbox cannot grow a stored record without bound.
 */
const invocationDiagnosticsSchema = stripStruct({
  stderrExcerpt: Schema.optional(Schema.String),
  exitCode: Schema.optional(safeIntegerSchema),
  httpStatus: Schema.optional(safeIntegerSchema),
  remoteJobId: Schema.optional(
    Schema.Union([Schema.String, Schema.Finite.check(Schema.isFinite())]),
  ),
  unreapedProcessIds: Schema.optional(Schema.Array(positiveIntegerSchema)),
  lifecycleError: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  sandboxError: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  sandboxCleanupConfirmed: Schema.optional(Schema.Boolean),
  sandboxCompletionConfirmed: Schema.optional(Schema.Boolean),
});

type CaseOutcome = typeof caseOutcomeSchema.Type;

type InvocationDiagnostics = typeof invocationDiagnosticsSchema.Type;

type InvocationErrorCode = typeof invocationErrorCodeSchema.Type;

type WarningCode = typeof warningCodeSchema.Type;

export {
  caseOutcomeSchema,
  invocationDiagnosticsSchema,
  invocationErrorCodeSchema,
  warningCodeSchema,
  type CaseOutcome,
  type InvocationDiagnostics,
  type InvocationErrorCode,
  type WarningCode,
};
