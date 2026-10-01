import {
  traceSchema,
  type JsonValue,
  type Span,
  type SpanKind,
  type Trace,
} from '@attest/contracts';
import { z } from 'zod';

import { otlpExportSchema, type OtlpScopeSpans, type OtlpSpan } from './otlp-schema.js';
import type { AttributeValue } from './otlp-value.js';
import { TraceConversionError } from './trace-conversion-error.js';

type Attributes = Record<string, AttributeValue>;

/** Framework attribute names copied to their GenAI semantic-convention equivalents. */
const GEN_AI_ALIASES: ReadonlyArray<[source: string, target: string]> = [
  ['ai.toolCall.name', 'gen_ai.tool.name'],
  ['tool.name', 'gen_ai.tool.name'],
  ['ai.toolCall.id', 'gen_ai.tool.call.id'],
  ['ai.toolCall.args', 'gen_ai.tool.call.arguments'],
  ['tool_arguments', 'gen_ai.tool.call.arguments'],
  ['ai.model.id', 'gen_ai.request.model'],
  ['ai.usage.promptTokens', 'gen_ai.usage.input_tokens'],
  ['ai.usage.completionTokens', 'gen_ai.usage.output_tokens'],
];

/** Attribute names holding span input and output, in priority order. */
const INPUT_ATTRIBUTES = {
  tool: ['gen_ai.tool.call.arguments'],
  other: ['input.value', 'inputs', 'ai.prompt'],
};
const OUTPUT_ATTRIBUTES = {
  tool: ['ai.toolCall.result', 'output.value', 'outputs'],
  other: ['output.value', 'outputs', 'ai.response.text'],
};

const formatIssues = (issues: readonly z.core.$ZodIssue[]): string =>
  issues
    .map(({ message, path }) => {
      const location = path.reduce<string>(
        (current, segment) =>
          typeof segment === 'number' ? `${current}[${segment}]` : `${current}.${String(segment)}`,
        '',
      );
      return `${location.replace(/^\./, '')}: ${message}`;
    })
    .join('; ');

const jsonValueSchema = z.json();

/** Decodes JSON-encoded attribute strings; anything else, including `1e999`, stays a string. */
const parseJsonAttribute = (value: AttributeValue): JsonValue => {
  if (typeof value !== 'string') return value;
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    return value;
  }
  const parsed = jsonValueSchema.safeParse(decoded);
  return parsed.success ? parsed.data : value;
};

const firstAttribute = (
  attributes: Attributes,
  names: readonly string[],
): AttributeValue | undefined =>
  names.map((name) => attributes[name]).find((value) => value !== undefined);

const normalizeGenAiAttributes = (attributes: Attributes): Attributes => {
  const normalized = { ...attributes };
  for (const [source, target] of GEN_AI_ALIASES) {
    if (normalized[target] === undefined && normalized[source] !== undefined) {
      normalized[target] = normalized[source];
    }
  }
  return normalized;
};

/** Maps common GenAI framework signals into Attest's intentionally small span-kind vocabulary. */
const inferSpanKind = (name: string, attributes: Attributes): SpanKind => {
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

const mapStatus = (status: OtlpSpan['status']): Span['status'] => {
  // OTLP STATUS_CODE_ERROR is 2; unset and ok both mean the span did not fail.
  if (Number(status?.code) !== 2) return { code: 'ok' };
  if (status?.message === undefined) return { code: 'error' };
  return { code: 'error', message: status.message };
};

const convertEvents = (events: OtlpSpan['events']): Span['events'] => {
  if (events === undefined || events.length === 0) return undefined;
  return events.map(({ name, timeUnixNano, attributes }) => ({
    name,
    time: timeUnixNano,
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
  }));
};

/** Converts one OTLP span, layering span attributes over inherited resource and scope ones. */
const convertSpan = (span: OtlpSpan, inheritedAttributes: Attributes): Span => {
  const attributes = normalizeGenAiAttributes({ ...inheritedAttributes, ...span.attributes });
  const events = convertEvents(span.events);
  const kind = inferSpanKind(span.name, attributes);
  const attributeGroup = kind === 'tool' ? 'tool' : 'other';
  const input = firstAttribute(attributes, INPUT_ATTRIBUTES[attributeGroup]);
  const output = firstAttribute(attributes, OUTPUT_ATTRIBUTES[attributeGroup]);
  return {
    span_id: span.spanId,
    parent_span_id: span.parentSpanId,
    name: span.name,
    kind,
    start_time: span.startTimeUnixNano,
    end_time: span.endTimeUnixNano,
    status: mapStatus(span.status),
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    ...(events === undefined ? {} : { events }),
    ...(input === undefined ? {} : { input: parseJsonAttribute(input) }),
    ...(output === undefined ? {} : { output: parseJsonAttribute(output) }),
  };
};

const scopeAttributes = (scopeSpans: OtlpScopeSpans, resourceAttributes: Attributes) => {
  const inherited = { ...resourceAttributes };
  if (scopeSpans.scope?.name !== undefined) inherited['otel.scope.name'] = scopeSpans.scope.name;
  if (scopeSpans.scope?.version !== undefined) {
    inherited['otel.scope.version'] = scopeSpans.scope.version;
  }
  return inherited;
};

const toTrace = (traceId: string, spans: Span[]): Trace => {
  const parsed = traceSchema.safeParse({ schema: 'attest.trace', trace_id: traceId, spans });
  if (!parsed.success) {
    throw new TraceConversionError(
      'invalid_otlp_json',
      `Converted trace ${traceId} is invalid: ${formatIssues(parsed.error.issues)}`,
    );
  }
  return parsed.data;
};

/**
 * Converts an OTLP/HTTP JSON trace export into one Attest trace per OTLP trace id, so traces
 * captured by existing framework instrumentation can be attached to cases.
 */
const convertOtlpJson = (candidate: unknown): Trace[] => {
  const parsed = otlpExportSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new TraceConversionError(
      'invalid_otlp_json',
      `OTLP JSON is invalid: ${formatIssues(parsed.error.issues)}`,
    );
  }
  const spansByTrace = new Map<string, Span[]>();
  for (const resourceSpans of parsed.data.resourceSpans) {
    for (const scopeSpans of resourceSpans.scopeSpans) {
      const inherited = scopeAttributes(scopeSpans, resourceSpans.resource.attributes);
      for (const span of scopeSpans.spans) {
        const spans = spansByTrace.get(span.traceId) ?? [];
        spans.push(convertSpan(span, inherited));
        spansByTrace.set(span.traceId, spans);
      }
    }
  }
  return [...spansByTrace].map(([traceId, spans]) => toTrace(traceId, spans));
};

/**
 * Picks one trace from a converted export. An export with several trace ids needs an explicit
 * id, because guessing would attach the wrong trace to a case.
 */
const selectConvertedTrace = (traces: Trace[], traceId?: string): Trace => {
  if (traceId !== undefined) {
    const selected = traces.find((trace) => trace.trace_id === traceId.toLowerCase());
    if (selected === undefined) {
      throw new TraceConversionError(
        'trace_not_found',
        `Trace ${traceId} was not present in the OTLP export.`,
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

export { convertOtlpJson, selectConvertedTrace };
