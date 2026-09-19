import type {
  AgentRequest,
  AgentResponse,
  ContractWarning,
  JsonValue,
  RawExcerpt,
  Span,
  Trace,
} from '@attest/contracts';
import type { StoredAttempt } from '@attest/core';
import { AgentInvocationError, redactTransportText, type InvocationResult } from '@attest/runtime';

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /authorization|cookie|password|secret|token|api[-_]?key/iu;

const REQUEST_FIELDS = new Set([
  'protocol',
  'run_id',
  'case_id',
  'input',
  'params',
  'messages',
  'turn_index',
  'conversation_id',
  'state',
]);
const RESPONSE_FIELDS = new Set(['protocol', 'output', 'error', 'state', 'trace']);
const TRACE_FIELDS = new Set(['schema', 'trace_id', 'spans']);
const SPAN_FIELDS = new Set([
  'span_id',
  'parent_span_id',
  'name',
  'kind',
  'start_time',
  'end_time',
  'status',
  'attributes',
  'events',
  'input',
  'output',
]);
const EVENT_FIELDS = new Set(['name', 'time', 'attributes']);
const STATUS_FIELDS = new Set(['code', 'message']);

const redactString = (value: string, secrets: readonly string[]): string =>
  redactTransportText(value, secrets);

/** Redacts JSON payload values and sensitive named fields without claiming their original type. */
const redactProbeValue = (value: unknown, secrets: readonly string[]): JsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => redactProbeValue(entry, secrets));
  if (typeof value !== 'object') return null;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [
        key,
        SENSITIVE_KEY.test(key) ? REDACTED : redactProbeValue(entry, secrets),
      ]),
  );
};

const redactExtensions = (
  value: Record<string, unknown>,
  knownFields: ReadonlySet<string>,
  secrets: readonly string[],
): Record<string, JsonValue> =>
  Object.fromEntries(
    Object.entries(value)
      .filter(([key, entry]) => !knownFields.has(key) && entry !== undefined)
      .map(([key, entry]) => [
        key,
        SENSITIVE_KEY.test(key) ? REDACTED : redactProbeValue(entry, secrets),
      ]),
  );

const redactAttributes = (
  attributes: Record<string, string | number | boolean> | undefined,
  secrets: readonly string[],
): Record<string, string | number | boolean> | undefined =>
  attributes === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(attributes).map(([key, value]) => [
          key,
          SENSITIVE_KEY.test(key)
            ? REDACTED
            : typeof value === 'string'
              ? redactString(value, secrets)
              : value,
        ]),
      );

/** Redacts trace payload text while retaining schema ids, span ids, enums, and timestamps. */
const redactTrace = (trace: Trace, secrets: readonly string[]): Trace => ({
  ...redactExtensions(trace, TRACE_FIELDS, secrets),
  schema: trace.schema,
  trace_id: trace.trace_id,
  spans: trace.spans.map((span): Span => ({
    ...redactExtensions(span, SPAN_FIELDS, secrets),
    span_id: span.span_id,
    parent_span_id: span.parent_span_id,
    name: redactString(span.name, secrets),
    kind: span.kind,
    start_time: span.start_time,
    end_time: span.end_time,
    status: {
      ...redactExtensions(span.status, STATUS_FIELDS, secrets),
      code: span.status.code,
      ...(span.status.message === undefined
        ? {}
        : { message: redactString(span.status.message, secrets) }),
    },
    ...(span.attributes === undefined
      ? {}
      : { attributes: redactAttributes(span.attributes, secrets) }),
    ...(span.events === undefined
      ? {}
      : {
          events: span.events.map((event) => ({
            ...redactExtensions(event, EVENT_FIELDS, secrets),
            name: redactString(event.name, secrets),
            time: event.time,
            ...(event.attributes === undefined
              ? {}
              : { attributes: redactAttributes(event.attributes, secrets) }),
          })),
        }),
    ...(span.input === undefined ? {} : { input: redactProbeValue(span.input, secrets) }),
    ...(span.output === undefined ? {} : { output: redactProbeValue(span.output, secrets) }),
  })),
});

/** Redacts caller data while retaining request identity and multi-turn structure. */
const redactAgentRequest = (request: AgentRequest, secrets: readonly string[]): AgentRequest => ({
  ...redactExtensions(request, REQUEST_FIELDS, secrets),
  protocol: request.protocol,
  run_id: request.run_id,
  case_id: request.case_id,
  input: redactProbeValue(request.input, secrets),
  ...(request.params === undefined
    ? {}
    : {
        params: Object.fromEntries(
          Object.entries(request.params).map(([key, value]) => [
            key,
            SENSITIVE_KEY.test(key) ? REDACTED : redactProbeValue(value, secrets),
          ]),
        ),
      }),
  ...(request.messages === undefined
    ? {}
    : {
        messages: request.messages.map((message) => ({
          role: message.role,
          content: redactString(message.content, secrets),
        })),
      }),
  ...(request.turn_index === undefined ? {} : { turn_index: request.turn_index }),
  ...(request.conversation_id === undefined ? {} : { conversation_id: request.conversation_id }),
  ...(request.state === undefined ? {} : { state: redactProbeValue(request.state, secrets) }),
});

/** Redacts response payloads while preserving protocol, error codes, and valid traces. */
const redactAgentResponse = (
  response: AgentResponse,
  secrets: readonly string[],
): AgentResponse => {
  const common = {
    ...redactExtensions(response, RESPONSE_FIELDS, secrets),
    protocol: response.protocol,
    ...(response.state === undefined ? {} : { state: redactProbeValue(response.state, secrets) }),
    ...(response.trace === undefined ? {} : { trace: redactTrace(response.trace, secrets) }),
  };
  if ('output' in response) {
    return { ...common, output: redactProbeValue(response.output, secrets) };
  }
  return {
    ...common,
    error: {
      message: redactString(response.error.message, secrets),
      ...(response.error.code === undefined ? {} : { code: response.error.code }),
    },
  };
};

/** Redacts diagnostic text while retaining numeric and remote correlation identities. */
const redactInvocationDiagnostics = (
  diagnostics: InvocationResult['diagnostics'],
  secrets: readonly string[],
): InvocationResult['diagnostics'] => ({
  ...(diagnostics.stderrExcerpt === undefined
    ? {}
    : { stderrExcerpt: redactString(diagnostics.stderrExcerpt, secrets) }),
  ...(diagnostics.exitCode === undefined ? {} : { exitCode: diagnostics.exitCode }),
  ...(diagnostics.httpStatus === undefined ? {} : { httpStatus: diagnostics.httpStatus }),
  ...(diagnostics.remoteJobId === undefined ? {} : { remoteJobId: diagnostics.remoteJobId }),
  ...(diagnostics.unreapedProcessIds === undefined
    ? {}
    : { unreapedProcessIds: [...diagnostics.unreapedProcessIds] }),
});

const redactWarnings = (
  warnings: readonly ContractWarning[],
  secrets: readonly string[],
): ContractWarning[] =>
  warnings.map((warning) => ({
    code: warning.code,
    path: warning.path,
    message: redactString(warning.message, secrets),
  }));

const redactRawExcerpt = (excerpt: RawExcerpt, secrets: readonly string[]): RawExcerpt => ({
  text: redactString(excerpt.text, secrets),
  truncated: excerpt.truncated,
  ...(excerpt.sha256 === undefined ? {} : { sha256: excerpt.sha256 }),
});

const redactAttempt = (
  attempt: InvocationResult['attempts'][number],
  secrets: readonly string[],
): InvocationResult['attempts'][number] => {
  const common = {
    diagnostics: redactInvocationDiagnostics(attempt.diagnostics, secrets),
    durationMs: attempt.durationMs,
    ...(attempt.rawExcerpt === undefined
      ? {}
      : { rawExcerpt: redactRawExcerpt(attempt.rawExcerpt, secrets) }),
    warnings: redactWarnings(attempt.warnings, secrets),
  };
  if (attempt.status === 'invocation_error') {
    return {
      ...common,
      status: 'invocation_error',
      error: new AgentInvocationError(
        attempt.error.code,
        redactString(attempt.error.message, secrets),
      ),
    };
  }

  const report = attempt.report;
  return {
    ...common,
    status: 'ok',
    raw: redactProbeValue(attempt.raw, secrets),
    ...(report === undefined
      ? {}
      : report.ok
        ? {
            report: {
              ok: true as const,
              value: redactAgentResponse(report.value, secrets),
              warnings: redactWarnings(report.warnings, secrets),
            },
          }
        : {
            report: {
              ok: false as const,
              errors: report.errors.map((error) => ({
                path: error.path,
                message: redactString(error.message, secrets),
              })),
              warnings: redactWarnings(report.warnings, secrets),
            },
          }),
  };
};

/** Redacts every text-bearing part of invocation evidence without changing schema fields. */
const redactInvocation = (
  invocation: InvocationResult,
  secrets: readonly string[],
): InvocationResult => {
  const attempts = invocation.attempts.map((attempt) => redactAttempt(attempt, secrets));
  const terminal = redactAttempt(invocation, secrets);
  return { ...terminal, attempts };
};

/** Converts an invocation attempt into its durable, schema-safe redacted projection. */
const redactStoredAttempt = (
  attempt: InvocationResult['attempts'][number],
  secrets: readonly string[],
): StoredAttempt => {
  const redacted = redactAttempt(attempt, secrets);
  const common = {
    diagnostics: redacted.diagnostics,
    durationMs: redacted.durationMs,
    ...(redacted.rawExcerpt === undefined ? {} : { rawExcerpt: redacted.rawExcerpt }),
    warnings: redacted.warnings,
  };
  return redacted.status === 'ok'
    ? { ...common, status: 'ok' }
    : {
        ...common,
        status: 'invocation_error',
        errorCode: redacted.error.code,
        errorMessage: redacted.error.message,
      };
};

export {
  REDACTED,
  redactAgentRequest,
  redactAgentResponse,
  redactInvocation,
  redactInvocationDiagnostics,
  redactProbeValue,
  redactRawExcerpt,
  redactStoredAttempt,
  redactTrace,
  redactWarnings,
};
