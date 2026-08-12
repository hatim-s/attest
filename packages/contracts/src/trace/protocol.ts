import { z } from 'zod';

import {
  TRACE_SCHEMA_ID,
  TRACE_SCHEMA_VERSION,
  currentOrLegacyIdentifier,
} from '../schema/identifiers.js';

const attributeValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const attributesSchema = z.record(z.string(), attributeValueSchema);
const timestampSchema = z.iso
  .datetime({ offset: false })
  .regex(/T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, 'timestamp must include whole seconds');

/** Encodes the span completion status from docs/specs/trace-schema.md. */
const spanStatusSchema = z.looseObject({
  code: z.enum(['ok', 'error']),
  message: z.string().optional(),
});

/** Encodes a point-in-time span event from docs/specs/trace-schema.md. */
const spanEventSchema = z.looseObject({
  name: z.string(),
  time: timestampSchema,
  attributes: attributesSchema.optional(),
});

/** Encodes the operation categories supported by docs/specs/trace-schema.md. */
const spanKindSchema = z.enum(['agent', 'llm', 'tool', 'retrieval', 'other']);

/** Names the operation categories supported by docs/specs/trace-schema.md. */
type SpanKind = z.infer<typeof spanKindSchema>;

/**
 * Encodes an open trace span from docs/specs/trace-schema.md while retaining vendor fields.
 */
const spanSchema = z
  .looseObject({
    span_id: z.string(),
    parent_span_id: z.string().nullable(),
    name: z.string(),
    kind: spanKindSchema,
    start_time: timestampSchema,
    end_time: timestampSchema,
    status: spanStatusSchema,
    attributes: attributesSchema.optional(),
    events: z.array(spanEventSchema).optional(),
    input: z.json().optional(),
    output: z.json().optional(),
  })
  .superRefine((span, context) => {
    if (Date.parse(span.end_time) >= Date.parse(span.start_time)) {
      return;
    }

    context.addIssue({
      code: 'custom',
      path: ['end_time'],
      message: 'end_time must be greater than or equal to start_time',
    });
  });

/** Represents one validated span while retaining additive extension fields. */
type Span = z.infer<typeof spanSchema>;

/**
 * Encodes the open trace document from docs/specs/trace-schema.md without stripping extensions.
 */
const traceSchema = z
  .looseObject({
    schema: currentOrLegacyIdentifier(TRACE_SCHEMA_ID, TRACE_SCHEMA_VERSION),
    trace_id: z.string(),
    spans: z.array(spanSchema),
  })
  .superRefine((trace, context) => {
    const spanIds = new Set<string>();
    trace.spans.forEach((span, spanIndex) => {
      if (spanIds.has(span.span_id)) {
        context.addIssue({
          code: 'custom',
          path: ['spans', spanIndex, 'span_id'],
          message: `duplicate span_id: ${span.span_id}`,
        });
      }
      spanIds.add(span.span_id);
    });
  });

/** Represents a validated attest trace document, including preserved extension fields. */
type Trace = z.infer<typeof traceSchema>;

export {
  spanEventSchema,
  spanKindSchema,
  spanSchema,
  spanStatusSchema,
  traceSchema,
  type Span,
  type SpanKind,
  type Trace,
};
