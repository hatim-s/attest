import {
  traceSchema,
  type JsonValue,
  type Span,
  type SpanKind,
  type Trace,
} from '@attest/contracts';

import { fromOtlpAttributes, type AttributeValue } from './otlp-value.js';
import { TraceConversionError, type ConvertOtlpJsonOptions } from './types.js';

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;

const requireString = (record: UnknownRecord, key: string, context: string): string => {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TraceConversionError('invalid_otlp_json', `${context}.${key} must be a string.`);
  }
  return value;
};

/** Narrows decoded JSON while rejecting non-finite numbers produced by extreme exponents. */
const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== 'object') return false;
  return Object.values(value).every(isJsonValue);
};

/** Converts an OTLP nanosecond timestamp to the RFC 3339 millisecond precision Attest accepts. */
const nanosecondsToTimestamp = (value: unknown, context: string): string => {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d+$/.test(String(value))) {
    throw new TraceConversionError(
      'invalid_otlp_json',
      `${context} must be an unsigned nanosecond timestamp.`,
    );
  }
  const nanoseconds = BigInt(value);
  const milliseconds = nanoseconds / 1_000_000n;
  const numericMilliseconds = Number(milliseconds);
  if (!Number.isSafeInteger(numericMilliseconds)) {
    throw new TraceConversionError('invalid_otlp_json', `${context} is outside the Date range.`);
  }
  const timestamp = new Date(numericMilliseconds);
  if (Number.isNaN(timestamp.getTime())) {
    throw new TraceConversionError('invalid_otlp_json', `${context} is outside the Date range.`);
  }
  return timestamp.toISOString();
};

const parseJsonAttribute = (value: AttributeValue | undefined): JsonValue | undefined => {
  if (typeof value !== 'string') return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return isJsonValue(parsed) ? parsed : value;
  } catch {
    return value;
  }
};

/** Adds stable GenAI aliases for framework attributes that predate or extend the convention. */
const normalizeGenAiAttributes = (
  attributes: Record<string, AttributeValue>,
): Record<string, AttributeValue> => {
  const normalized = { ...attributes };
  const aliases: Array<[string, string]> = [
    ['ai.toolCall.name', 'gen_ai.tool.name'],
    ['tool.name', 'gen_ai.tool.name'],
    ['ai.toolCall.id', 'gen_ai.tool.call.id'],
    ['ai.toolCall.args', 'gen_ai.tool.call.arguments'],
    ['tool_arguments', 'gen_ai.tool.call.arguments'],
    ['ai.model.id', 'gen_ai.request.model'],
    ['ai.usage.promptTokens', 'gen_ai.usage.input_tokens'],
    ['ai.usage.completionTokens', 'gen_ai.usage.output_tokens'],
  ];
  for (const [source, target] of aliases) {
    if (normalized[target] === undefined && normalized[source] !== undefined) {
      normalized[target] = normalized[source];
    }
  }
  return normalized;
};

/** Maps common GenAI framework signals into Attest's intentionally small span-kind vocabulary. */
const inferSpanKind = (name: string, attributes: Record<string, AttributeValue>): SpanKind => {
  const langSmithKind = String(attributes['langsmith.span.kind'] ?? '').toLowerCase();
  const operation = String(
    attributes['gen_ai.operation.name'] ?? attributes['ai.operationId'] ?? '',
  ).toLowerCase();
  const lowerName = name.toLowerCase();
  if (
    attributes['gen_ai.tool.name'] !== undefined ||
    langSmithKind === 'tool' ||
    operation.includes('toolcall') ||
    lowerName.includes('toolcall')
  ) {
    return 'tool';
  }
  if (langSmithKind === 'retriever' || lowerName.includes('retriev')) return 'retrieval';
  if (
    langSmithKind === 'llm' ||
    operation.includes('dogenerate') ||
    operation.includes('dostream') ||
    ['chat', 'text_completion', 'generate_content'].includes(operation) ||
    lowerName.includes('llm')
  ) {
    return 'llm';
  }
  if (
    ['agent', 'chain'].includes(langSmithKind) ||
    operation.includes('agent') ||
    operation === 'ai.generatetext' ||
    operation === 'ai.streamtext' ||
    lowerName.includes('agent')
  ) {
    return 'agent';
  }
  return 'other';
};

const mapStatus = (candidate: unknown): Span['status'] => {
  const status = asRecord(candidate);
  const code = status?.code;
  return Number(code) === 2
    ? { code: 'error', ...(typeof status?.message === 'string' ? { message: status.message } : {}) }
    : { code: 'ok' };
};

const convertEvents = (candidate: unknown, context: string): Span['events'] => {
  if (!Array.isArray(candidate) || candidate.length === 0) return undefined;
  return candidate.map((event, index) => {
    const record = asRecord(event);
    if (record === undefined) {
      throw new TraceConversionError(
        'invalid_otlp_json',
        `${context}[${index}] must be an object.`,
      );
    }
    const attributes = fromOtlpAttributes(record.attributes);
    return {
      name: requireString(record, 'name', `${context}[${index}]`),
      time: nanosecondsToTimestamp(record.timeUnixNano, `${context}[${index}].timeUnixNano`),
      ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    };
  });
};

/** Converts one OTLP span while preserving scalar resource, scope, and span attributes. */
const convertSpan = (
  candidate: unknown,
  inheritedAttributes: Record<string, AttributeValue>,
  context: string,
): { traceId: string; span: Span } => {
  const record = asRecord(candidate);
  if (record === undefined) {
    throw new TraceConversionError('invalid_otlp_json', `${context} must be an object.`);
  }
  const traceId = requireString(record, 'traceId', context).toLowerCase();
  const spanId = requireString(record, 'spanId', context).toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(traceId) || !/^[a-f0-9]{16}$/.test(spanId)) {
    throw new TraceConversionError(
      'invalid_otlp_json',
      `${context} must contain 32-character traceId and 16-character spanId hex strings.`,
    );
  }
  const parentValue = record.parentSpanId;
  const parentSpanId =
    parentValue === undefined || parentValue === ''
      ? null
      : typeof parentValue === 'string' && /^[a-fA-F0-9]{16}$/.test(parentValue)
        ? parentValue.toLowerCase()
        : undefined;
  if (parentSpanId === undefined) {
    throw new TraceConversionError('invalid_otlp_json', `${context}.parentSpanId must be hex.`);
  }
  const name = requireString(record, 'name', context);
  const attributes = normalizeGenAiAttributes({
    ...inheritedAttributes,
    ...fromOtlpAttributes(record.attributes),
  });
  const events = convertEvents(record.events, `${context}.events`);
  const kind = inferSpanKind(name, attributes);
  const inputSource =
    kind === 'tool'
      ? attributes['gen_ai.tool.call.arguments']
      : (attributes['input.value'] ?? attributes.inputs ?? attributes['ai.prompt']);
  const outputSource =
    kind === 'tool'
      ? (attributes['ai.toolCall.result'] ?? attributes['output.value'] ?? attributes.outputs)
      : (attributes['output.value'] ?? attributes.outputs ?? attributes['ai.response.text']);
  return {
    traceId,
    span: {
      span_id: spanId,
      parent_span_id: parentSpanId,
      name,
      kind,
      start_time: nanosecondsToTimestamp(record.startTimeUnixNano, `${context}.startTimeUnixNano`),
      end_time: nanosecondsToTimestamp(record.endTimeUnixNano, `${context}.endTimeUnixNano`),
      status: mapStatus(record.status),
      ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
      ...(events === undefined ? {} : { events }),
      ...(inputSource === undefined ? {} : { input: parseJsonAttribute(inputSource) }),
      ...(outputSource === undefined ? {} : { output: parseJsonAttribute(outputSource) }),
    },
  };
};

/** Converts an OTLP/HTTP JSON trace export into one Attest trace per OTLP trace id. */
const convertOtlpJson = (candidate: unknown): Trace[] => {
  const document = asRecord(candidate);
  if (document === undefined || !Array.isArray(document.resourceSpans)) {
    throw new TraceConversionError(
      'invalid_otlp_json',
      'OTLP JSON must contain a resourceSpans array.',
    );
  }
  const converted: Array<{ traceId: string; span: Span }> = [];
  document.resourceSpans.forEach((resourceSpan, resourceIndex) => {
    const resourceRecord = asRecord(resourceSpan);
    const resourceAttributes = fromOtlpAttributes(asRecord(resourceRecord?.resource)?.attributes);
    const scopeSpans = resourceRecord?.scopeSpans;
    if (!Array.isArray(scopeSpans)) {
      throw new TraceConversionError(
        'invalid_otlp_json',
        `resourceSpans[${resourceIndex}].scopeSpans must be an array.`,
      );
    }
    scopeSpans.forEach((scopeSpan, scopeIndex) => {
      const scopeRecord = asRecord(scopeSpan);
      const scope = asRecord(scopeRecord?.scope);
      const inherited = { ...resourceAttributes };
      if (typeof scope?.name === 'string') inherited['otel.scope.name'] = scope.name;
      if (typeof scope?.version === 'string') inherited['otel.scope.version'] = scope.version;
      if (!Array.isArray(scopeRecord?.spans)) {
        throw new TraceConversionError(
          'invalid_otlp_json',
          `resourceSpans[${resourceIndex}].scopeSpans[${scopeIndex}].spans must be an array.`,
        );
      }
      scopeRecord.spans.forEach((span, spanIndex) => {
        converted.push(
          convertSpan(
            span,
            inherited,
            `resourceSpans[${resourceIndex}].scopeSpans[${scopeIndex}].spans[${spanIndex}]`,
          ),
        );
      });
    });
  });
  const groups = new Map<string, Span[]>();
  for (const { traceId, span } of converted) {
    const spans = groups.get(traceId) ?? [];
    spans.push(span);
    groups.set(traceId, spans);
  }
  return [...groups.entries()].map(([traceId, spans]) => {
    const parsed = traceSchema.safeParse({
      schema: 'attest.trace',
      trace_id: traceId,
      spans,
    });
    if (!parsed.success) {
      throw new TraceConversionError(
        'invalid_otlp_json',
        `Converted trace ${traceId} is invalid: ${parsed.error.issues.map(({ message, path }) => `${path.join('.')}: ${message}`).join('; ')}`,
      );
    }
    return parsed.data;
  });
};

/** Selects one converted trace explicitly when an export contains more than one trace id. */
const selectConvertedTrace = (traces: Trace[], options: ConvertOtlpJsonOptions = {}): Trace => {
  if (options.traceId !== undefined) {
    const requestedTraceId = options.traceId.toLowerCase();
    const selected = traces.find((trace) => trace.trace_id === requestedTraceId);
    if (selected === undefined) {
      throw new TraceConversionError(
        'trace_not_found',
        `Trace ${options.traceId} was not present in the OTLP export.`,
      );
    }
    return selected;
  }
  if (traces.length !== 1) {
    throw new TraceConversionError(
      'ambiguous_trace_export',
      `OTLP export contains ${traces.length} traces; pass --trace-id to select one.`,
    );
  }
  return traces[0]!;
};

export {
  convertOtlpJson,
  inferSpanKind,
  nanosecondsToTimestamp,
  normalizeGenAiAttributes,
  selectConvertedTrace,
};
