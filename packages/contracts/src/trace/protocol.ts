import { timestampSchema as offsetTimestampSchema } from '../schema/scalars.js';
import { looseStruct } from '../schema/objects.js';
import * as Schema from 'effect/Schema';

import { reportDuplicates } from '../internal/duplicates.js';
import { TRACE_SCHEMA_ID } from '../schema/identifiers.js';

/** Span attribute values; filters match against the same scalar set. */
const attributeValueSchema = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]);

const attributesSchema = Schema.Record(Schema.String, attributeValueSchema);

const timestampSchema = offsetTimestampSchema.check(
  Schema.isPattern(/T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, {
    message: 'timestamp must include whole seconds',
  }),
);

/** Encodes the span completion status from docs/specs/trace-schema.md. */
const spanStatusSchema = looseStruct({
  code: Schema.Literals(['ok', 'error']),
  message: Schema.optional(Schema.String),
});

/** Encodes a point-in-time span event from docs/specs/trace-schema.md. */
const spanEventSchema = looseStruct({
  name: Schema.String,
  time: timestampSchema,
  attributes: Schema.optional(attributesSchema),
});

/** Encodes the operation categories supported by docs/specs/trace-schema.md. */
const spanKindSchema = Schema.Literals(['agent', 'llm', 'tool', 'retrieval', 'other']);

/** Names the operation categories supported by docs/specs/trace-schema.md. */
type SpanKind = typeof spanKindSchema.Type;

/**
 * Encodes an open trace span from docs/specs/trace-schema.md while retaining vendor fields.
 */
const spanSchema = looseStruct({
  span_id: Schema.String,
  parent_span_id: Schema.NullOr(Schema.String),
  name: Schema.String,
  kind: spanKindSchema,
  start_time: timestampSchema,
  end_time: timestampSchema,
  status: spanStatusSchema,
  attributes: Schema.optional(attributesSchema),
  events: Schema.optional(Schema.Array(spanEventSchema)),
  input: Schema.optional(Schema.Json),
  output: Schema.optional(Schema.Json),
}).check(
  Schema.makeFilter((span) => {
    const context: Schema.FilterIssue[] = [];

    if (Date.parse(span.end_time) >= Date.parse(span.start_time)) {
      return context;
    }

    context.push({
      path: ['end_time'],
      issue: 'end_time must be greater than or equal to start_time',
    });

    return context;
  }),
);

/** Represents one validated span while retaining additive extension fields. */
type Span = typeof spanSchema.Type;

/**
 * Encodes the open trace document from docs/specs/trace-schema.md without stripping extensions.
 */
const traceSchema = looseStruct({
  schema: Schema.Literal(TRACE_SCHEMA_ID),
  trace_id: Schema.String,
  spans: Schema.Array(spanSchema),
}).check(
  Schema.makeFilter((trace) => {
    const context: Schema.FilterIssue[] = [];
    reportDuplicates({
      values: trace.spans.map(({ span_id }) => span_id),
      pathFor: (index) => ['spans', index, 'span_id'],
      label: 'span_id',
      context,
    });

    return context;
  }),
);

/** Represents a validated attest trace document, including preserved extension fields. */
type Trace = typeof traceSchema.Type;

export {
  attributeValueSchema,
  spanKindSchema,
  spanSchema,
  spanStatusSchema,
  traceSchema,
  type Span,
  type SpanKind,
  type Trace,
};
