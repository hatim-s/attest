import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import * as Cause from 'effect/Cause';

import {
  agentRequestSchema,
  agentResponseSchema,
  type AgentRequest,
  type AgentResponse,
} from '../agent/protocol.js';
import { agentCompletionSchema, type AgentCompletion } from '../agent/completion.js';
import { SchemaDecodeError, formatContractIssues, type ContractIssue } from '../internal/issues.js';
import {
  metricRequestSchema,
  metricResultSchema,
  type MetricRequest,
  type MetricResult,
} from '../metric/protocol.js';
import { err, ok, type Result } from '../result.js';
import { traceSchema, type Trace } from '../trace/protocol.js';
import { type WarningCode } from '../eval/execution.js';

/** Describes a recoverable extension or optional-payload problem. */
type ContractWarning = {
  path: string;
  message: string;
  code: WarningCode;
};

/** Reports successful parsing and recoverable warnings without conflating them with errors. */
type ParseReport<T> =
  | { ok: true; value: T; warnings: ContractWarning[] }
  | { ok: false; errors: ContractIssue[]; warnings: ContractWarning[] };

/** Decodes an owner schema into the public Result while preserving native validation details. */
// BOUNDARY: Untyped transport payloads are checked by the supplied owner schema before returning its domain type.
const parseWithSchema = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  candidate: unknown,
): Result<S['Type'], SchemaDecodeError> => {
  const parsed = Effect.runSyncExit(Effect.result(parseWithSchemaEffect(schema, candidate)));

  if (parsed._tag === 'Failure') throw Cause.squash(parsed.cause);

  return parsed.value._tag === 'Success' ? ok(parsed.value.success) : err(parsed.value.failure);
};

/** Suspends user refinements so thrown exceptions remain defects at execution time. */
// BOUNDARY: The owner schema validates unknown transport input only when the Effect executes.
const parseWithSchemaEffect = <S extends Schema.ConstraintDecoder<unknown, unknown>>(
  schema: S,
  candidate: unknown,
): Effect.Effect<S['Type'], SchemaDecodeError, S['DecodingServices']> =>
  Effect.suspend(() =>
    Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error', errors: 'all' })(
      candidate,
    ).pipe(Effect.mapError((cause) => new SchemaDecodeError(cause))),
  );

/** Throws the same diagnostic error used by the nonthrowing boundaries. */
// BOUNDARY: The owner schema validates unknown input before returning its inferred domain type.
const parseWithSchemaSync = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  candidate: unknown,
): S['Type'] => {
  const result = parseWithSchema(schema, candidate);

  if (!result.ok) throw result.error;

  return result.value;
};

/** Keeps protocol parsers' existing dependency-free diagnostics. */
// BOUNDARY: Protocol inputs pass through the shared decoder before issue projection.
const parseContract = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  candidate: unknown,
): Result<S['Type'], ContractIssue[]> => {
  const result = parseWithSchema(schema, candidate);

  return result.ok ? result : err(formatContractIssues(result.error.issues));
};

// BOUNDARY: Agent transport response objects are inspected only to report fields outside the response schema.
const reportUnknownAgentResponseFields = (candidate: unknown): ContractWarning[] => {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return [];
  }

  return Object.keys(candidate)
    .filter((fieldName) => !Object.hasOwn(agentResponseSchema.schema.fields, fieldName))
    .map((fieldName) => ({
      path: fieldName,
      message: `unknown top-level response field preserved: ${fieldName}`,
      code: 'unknown_field',
    }));
};

const reportInvalidTrace = (issues: ContractIssue[]): ContractWarning => ({
  path: 'trace',
  message: `invalid trace: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
  code: 'invalid_trace',
});

/**
 * Validates an agent request without throwing, so transports can report contract issues as data.
 */
// BOUNDARY: Agent transport request JSON is validated against agentRequestSchema.
const parseAgentRequest = (candidate: unknown): Result<AgentRequest, ContractIssue[]> =>
  parseContract(agentRequestSchema, candidate);

/**
 * Validates an agent response without throwing. The trace is optional evidence, so a malformed
 * trace is dropped with a warning instead of failing an otherwise usable response.
 */
// BOUNDARY: Agent transport response JSON is validated; invalid optional trace evidence is reported and discarded.
const parseAgentResponse = (candidate: unknown): ParseReport<AgentResponse> => {
  const warnings = reportUnknownAgentResponseFields(candidate);
  const parsed = parseContract(agentResponseSchema, candidate);

  if (!parsed.ok) {
    return { ok: false, errors: parsed.error, warnings };
  }

  const { trace, ...fields } = parsed.value;
  // The schema refinement guarantees exactly one of output or error.
  // SAFETY: agentResponseSchema enforces exactly one output or error and trace is optional in AgentResponse.
  const response = fields as AgentResponse;

  if (trace === undefined) {
    return { ok: true, value: response, warnings };
  }

  const parsedTrace = parseTrace(trace);

  if (!parsedTrace.ok) {
    return {
      ok: true,
      value: response,
      warnings: [...warnings, reportInvalidTrace(parsedTrace.error)],
    };
  }

  return { ok: true, value: { ...response, trace: parsedTrace.value }, warnings };
};

/**
 * Validates an async agent's completion without throwing and narrows it on its single outcome.
 * The trace stays unvalidated; parseAgentResponse checks it once the callback adapter has built
 * the response envelope.
 */
// BOUNDARY: Completion bodies posted to a callback receiver are validated against agentCompletionSchema.
const parseAgentCompletion = (candidate: unknown): Result<AgentCompletion, ContractIssue[]> => {
  const parsed = parseContract(agentCompletionSchema, candidate);

  if (!parsed.ok) return parsed;
  const { output, error, ...fields } = parsed.value;

  if (error !== undefined) return ok({ ...fields, error });

  if (output !== undefined) return ok({ ...fields, output });

  // The schema refinement already rejects this; the branch keeps the narrowing cast-free.
  return err([{ path: 'output', message: 'exactly one of output or error must be present' }]);
};

/** Validates a trace document without throwing; extension fields are preserved. */
// BOUNDARY: Untrusted trace JSON is validated against traceSchema.
const parseTrace = (candidate: unknown): Result<Trace, ContractIssue[]> =>
  parseContract(traceSchema, candidate);

/** Validates an executable metric request without throwing. */
// BOUNDARY: Metric transport request JSON is validated against metricRequestSchema.
const parseMetricRequest = (candidate: unknown): Result<MetricRequest, ContractIssue[]> =>
  parseContract(metricRequestSchema, candidate);

/** Validates a metric result envelope without throwing. */
// BOUNDARY: Metric transport result JSON is validated against metricResultSchema.
const parseMetricResult = (candidate: unknown): Result<MetricResult, ContractIssue[]> =>
  parseContract(metricResultSchema, candidate);

export {
  SchemaDecodeError,
  parseWithSchema,
  parseWithSchemaEffect,
  parseWithSchemaSync,
  formatContractIssues,
  parseAgentCompletion,
  parseAgentRequest,
  parseAgentResponse,
  parseMetricRequest,
  parseMetricResult,
  parseTrace,
  type ContractIssue,
  type ContractWarning,
  type ParseReport,
};
