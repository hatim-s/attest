import type {
  AgentErrorResponse,
  AgentRequest,
  AgentResponse,
  ContractWarning,
  JsonValue,
  RawExcerpt,
  Span,
  Trace,
} from '@attest/contracts';
import type { StoredAttempt, StoredMetricEvaluation } from '@attest/core';
import { AgentInvocationError, redactTransportText, type InvocationResult } from '@attest/executor';

import { REDACTED, isSensitiveFieldName } from '../../../internal/redaction.js';

const isString = (value: unknown): value is string => typeof value === 'string';

type ResponseCommon = Pick<AgentResponse, 'protocol' | 'state' | 'trace'>;

type AttemptCommon = Pick<
  InvocationResult['attempts'][number],
  'diagnostics' | 'durationMs' | 'rawExcerpt' | 'warnings'
>;

type StoredAttemptCommon = Pick<
  StoredAttempt,
  'diagnostics' | 'durationMs' | 'rawExcerpt' | 'warnings'
>;

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

/** Redacts JSON payload values and sensitive named fields without claiming their original type. */
// BOUNDARY: Agent extensions and probe output are untrusted; recursively sanitize them to finite JSON values and redact secrets before reporting.
const redactProbeValue = (value: unknown, secrets: readonly string[]): JsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;

  if (typeof value === 'string') return redactTransportText(value, secrets);

  if (Array.isArray(value)) return value.map((entry) => redactProbeValue(entry, secrets));

  if (typeof value !== 'object') return null;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [
        key,
        isSensitiveFieldName(key) ? REDACTED : redactProbeValue(entry, secrets),
      ]),
  );
};

// BOUNDARY: Agent schema catchall fields are untrusted extensions; each extension is sanitized to JsonValue and secret strings are removed.
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
        isSensitiveFieldName(key) ? REDACTED : redactProbeValue(entry, secrets),
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
          isSensitiveFieldName(key)
            ? REDACTED
            : isString(value)
              ? redactTransportText(value, secrets)
              : value,
        ]),
      );

/** Redacts optional span status text while retaining the status code and extension fields. */
const redactSpanStatus = (status: Span['status'], secrets: readonly string[]): Span['status'] => {
  const redacted: Span['status'] = {
    ...redactExtensions(status, STATUS_FIELDS, secrets),
    code: status.code,
  };

  if (status.message !== undefined) redacted.message = redactTransportText(status.message, secrets);

  return redacted;
};

/** Redacts trace payload text while retaining schema ids, span ids, enums, and timestamps. */
const redactTrace = (trace: Trace, secrets: readonly string[]): Trace => ({
  ...redactExtensions(trace, TRACE_FIELDS, secrets),
  schema: trace.schema,
  trace_id: trace.trace_id,
  spans: trace.spans.map((span): Span => {
    const redacted: Span = {
      ...redactExtensions(span, SPAN_FIELDS, secrets),
      span_id: span.span_id,
      parent_span_id: span.parent_span_id,
      name: redactTransportText(span.name, secrets),
      kind: span.kind,
      start_time: span.start_time,
      end_time: span.end_time,
      status: redactSpanStatus(span.status, secrets),
    };

    if (!(span.attributes === undefined)) {
      redacted.attributes = redactAttributes(span.attributes, secrets);
    }

    if (!(span.events === undefined)) {
      redacted.events = span.events.map((event) => {
        const redactedEvent: NonNullable<Span['events']>[number] = {
          ...redactExtensions(event, EVENT_FIELDS, secrets),
          name: redactTransportText(event.name, secrets),
          time: event.time,
        };

        if (event.attributes !== undefined)
          redactedEvent.attributes = redactAttributes(event.attributes, secrets);

        return redactedEvent;
      });
    }

    if (!(span.input === undefined)) {
      redacted.input = redactProbeValue(span.input, secrets);
    }

    if (!(span.output === undefined)) {
      redacted.output = redactProbeValue(span.output, secrets);
    }

    return redacted;
  }),
});

/** Redacts caller data while retaining request identity and multi-turn structure. */
const redactAgentRequest = (request: AgentRequest, secrets: readonly string[]): AgentRequest => {
  const redacted: AgentRequest = {
    ...redactExtensions(request, REQUEST_FIELDS, secrets),
    protocol: request.protocol,
    run_id: request.run_id,
    case_id: request.case_id,
    input: redactProbeValue(request.input, secrets),
  };

  if (!(request.params === undefined)) {
    redacted.params = Object.fromEntries(
      Object.entries(request.params).map(([key, value]) => [
        key,
        isSensitiveFieldName(key) ? REDACTED : redactProbeValue(value, secrets),
      ]),
    );
  }

  if (!(request.messages === undefined)) {
    redacted.messages = request.messages.map((message) => ({
      role: message.role,
      content: redactTransportText(message.content, secrets),
    }));
  }

  if (!(request.turn_index === undefined)) {
    redacted.turn_index = request.turn_index;
  }

  if (!(request.conversation_id === undefined)) {
    redacted.conversation_id = request.conversation_id;
  }

  if (!(request.state === undefined)) {
    redacted.state = redactProbeValue(request.state, secrets);
  }

  return redacted;
};

/** Redacts response payloads while preserving protocol, error codes, and valid traces. */
const redactAgentResponse = (
  response: AgentResponse,
  secrets: readonly string[],
): AgentResponse => {
  const common: ResponseCommon = {
    ...redactExtensions(response, RESPONSE_FIELDS, secrets),
    protocol: response.protocol,
  };

  if (response.state !== undefined) common.state = redactProbeValue(response.state, secrets);

  if (response.trace !== undefined) common.trace = redactTrace(response.trace, secrets);

  if ('output' in response) {
    return { ...common, output: redactProbeValue(response.output, secrets) };
  }

  const error: AgentErrorResponse['error'] = {
    message: redactTransportText(response.error.message, secrets),
  };

  if (response.error.code !== undefined) error.code = response.error.code;

  return { ...common, error };
};

/** Redacts diagnostic text while retaining numeric and remote correlation identities. */
const redactInvocationDiagnostics = (
  diagnostics: InvocationResult['diagnostics'],
  secrets: readonly string[],
): InvocationResult['diagnostics'] => {
  const redacted: InvocationResult['diagnostics'] = {};

  if (!(diagnostics.stderrExcerpt === undefined)) {
    redacted.stderrExcerpt = redactTransportText(diagnostics.stderrExcerpt, secrets);
  }

  if (!(diagnostics.sandboxError === undefined)) {
    redacted.sandboxError = redactTransportText(diagnostics.sandboxError, secrets);
  }

  if (!(diagnostics.lifecycleError === undefined)) {
    redacted.lifecycleError = redactTransportText(diagnostics.lifecycleError, secrets);
  }

  if (!(diagnostics.sandboxCleanupConfirmed === undefined)) {
    redacted.sandboxCleanupConfirmed = diagnostics.sandboxCleanupConfirmed;
  }

  if (!(diagnostics.sandboxCompletionConfirmed === undefined)) {
    redacted.sandboxCompletionConfirmed = diagnostics.sandboxCompletionConfirmed;
  }

  if (!(diagnostics.exitCode === undefined)) {
    redacted.exitCode = diagnostics.exitCode;
  }

  if (!(diagnostics.httpStatus === undefined)) {
    redacted.httpStatus = diagnostics.httpStatus;
  }

  if (!(diagnostics.remoteJobId === undefined)) {
    redacted.remoteJobId = diagnostics.remoteJobId;
  }

  if (!(diagnostics.unreapedProcessIds === undefined)) {
    redacted.unreapedProcessIds = [...diagnostics.unreapedProcessIds];
  }

  return redacted;
};

const redactWarnings = (
  warnings: readonly ContractWarning[],
  secrets: readonly string[],
): ContractWarning[] =>
  warnings.map((warning) => ({
    code: warning.code,
    path: warning.path,
    message: redactTransportText(warning.message, secrets),
  }));

const redactRawExcerpt = (excerpt: RawExcerpt, secrets: readonly string[]): RawExcerpt => {
  const redacted: RawExcerpt = {
    text: redactTransportText(excerpt.text, secrets),
    truncated: excerpt.truncated,
  };

  if (!(excerpt.sha256 === undefined)) {
    redacted.sha256 = excerpt.sha256;
  }

  return redacted;
};

const redactAttempt = (
  attempt: InvocationResult['attempts'][number],
  secrets: readonly string[],
): InvocationResult['attempts'][number] => {
  const common: AttemptCommon = {
    diagnostics: redactInvocationDiagnostics(attempt.diagnostics, secrets),
    durationMs: attempt.durationMs,
    warnings: redactWarnings(attempt.warnings, secrets),
  };

  if (attempt.rawExcerpt !== undefined)
    common.rawExcerpt = redactRawExcerpt(attempt.rawExcerpt, secrets);

  if (attempt.status === 'invocation_error') {
    return {
      ...common,
      status: 'invocation_error',
      error: new AgentInvocationError(
        attempt.error.code,
        redactTransportText(attempt.error.message, secrets),
      ),
    };
  }

  const report = attempt.report;

  const redacted: Extract<InvocationResult['attempts'][number], { status: 'ok' }> = {
    ...common,
    status: 'ok',
    raw: redactProbeValue(attempt.raw, secrets),
  };

  if (report !== undefined) {
    redacted.report = report.ok
      ? {
          ok: true,
          value: redactAgentResponse(report.value, secrets),
          warnings: redactWarnings(report.warnings, secrets),
        }
      : {
          ok: false,
          errors: report.errors.map((error) => ({
            path: error.path,
            message: redactTransportText(error.message, secrets),
          })),
          warnings: redactWarnings(report.warnings, secrets),
        };
  }

  return redacted;
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

  const common: StoredAttemptCommon = {
    diagnostics: redacted.diagnostics,
    durationMs: redacted.durationMs,
    warnings: redacted.warnings,
  };

  if (redacted.rawExcerpt !== undefined) common.rawExcerpt = redacted.rawExcerpt;

  return redacted.status === 'ok'
    ? { ...common, status: 'ok' }
    : {
        ...common,
        status: 'invocation_error',
        errorCode: redacted.error.code,
        errorMessage: redacted.error.message,
      };
};

/**
 * Redacts metric evidence while preserving identities and discriminants used by persistence.
 * Metrics score unredacted output and can echo it, so sensitive field names are redacted even
 * when no secret values are configured.
 */
const redactMetricEvaluation = (
  evaluation: StoredMetricEvaluation,
  secrets: readonly string[],
): StoredMetricEvaluation => {
  const evidence = {
    rationale:
      evaluation.rationale === undefined
        ? undefined
        : redactTransportText(evaluation.rationale, secrets),
    details:
      evaluation.details === undefined ? undefined : redactProbeValue(evaluation.details, secrets),
    judgeIo:
      evaluation.judgeIo === undefined ? undefined : redactProbeValue(evaluation.judgeIo, secrets),
  };

  if (evaluation.status === 'error') {
    return {
      ...evaluation,
      ...evidence,
      error: {
        ...evaluation.error,
        message: redactTransportText(evaluation.error.message, secrets),
      },
    };
  }

  return { ...evaluation, ...evidence };
};

export {
  redactAgentRequest,
  redactAgentResponse,
  redactInvocation,
  redactInvocationDiagnostics,
  redactMetricEvaluation,
  redactProbeValue,
  redactStoredAttempt,
  redactTrace,
  redactWarnings,
};
