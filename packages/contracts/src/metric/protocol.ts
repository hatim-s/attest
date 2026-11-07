import { nonnegativeIntegerSchema } from '../schema/scalars.js';
import { looseStruct } from '../schema/objects.js';
import * as Schema from 'effect/Schema';

import { inlineArtifactSchema } from '../agent/artifact.js';
import { jsonValueSchema } from '../project/shared.js';
import {
  attributeValueSchema,
  spanKindSchema,
  spanStatusSchema,
  traceSchema,
} from '../trace/protocol.js';
import { METRIC_PROTOCOL } from '../schema/identifiers.js';

const pathSchema = Schema.String.check(
  Schema.isPattern(/^\$(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*$/),
);

// 'g' and 'y' are deliberately excluded: they make RegExp.test stateful via lastIndex,
// which would turn assertion evaluation order into a correctness hazard.
const regularExpressionFlagsSchema = Schema.String.check(Schema.isPattern(/^[dimsuv]*$/));

// Syntax is checked here; the engine enforces a per-check time guard at evaluation.
const isValidRegularExpression = (value: { pattern: string; flags?: string }): boolean => {
  try {
    new RegExp(value.pattern, value.flags);

    return true;
  } catch {
    return false;
  }
};

const regexCheckSchema = Schema.Struct({
  path: pathSchema,
  pattern: Schema.String,
  flags: Schema.optional(regularExpressionFlagsSchema),
}).check(
  Schema.makeFilter((value) =>
    isValidRegularExpression(value)
      ? undefined
      : 'pattern and flags must form a valid regular expression',
  ),
);

const thresholdSchema = Schema.Struct({
  path: pathSchema,
  lt: Schema.optional(Schema.Finite.check(Schema.isFinite())),
  lte: Schema.optional(Schema.Finite.check(Schema.isFinite())),
  gt: Schema.optional(Schema.Finite.check(Schema.isFinite())),
  gte: Schema.optional(Schema.Finite.check(Schema.isFinite())),
})
  .check(
    Schema.makeFilter((threshold) => {
      const context: Schema.FilterIssue[] = [];
      const comparisons = [threshold.lt, threshold.lte, threshold.gt, threshold.gte];

      if (comparisons.some((comparison) => comparison !== undefined)) {
        return context;
      }

      context.push({
        path: ['lt'],
        issue: 'at least one threshold comparison is required',
      });

      return context;
    }),
  )
  .annotate({ identifier: 'Threshold' });

const pathValueCheckSchema = Schema.Struct({ path: pathSchema, value: jsonValueSchema });

const existsCheckSchema = Schema.Struct({ path: pathSchema });

const toolArgumentMatcherSchema = Schema.Union([
  Schema.Struct({ equals: pathValueCheckSchema }),
  Schema.Struct({ contains: pathValueCheckSchema }),
  Schema.Struct({ exists: existsCheckSchema }),
]);

/** Matches trace spans through stable core fields and a partial attribute map. */
const spanFilterSchema = Schema.Struct({
  kind: Schema.optional(spanKindSchema),
  name: Schema.optional(Schema.String),
  status: Schema.optional(spanStatusSchema.schema.fields.code),
  attributes: Schema.optional(Schema.Record(Schema.String, attributeValueSchema)),
});

const leafAssertionCheckSchema = Schema.Union([
  Schema.Struct({ equals: pathValueCheckSchema }),
  Schema.Struct({ contains: pathValueCheckSchema }),
  Schema.Struct({ regex: regexCheckSchema }),
  Schema.Struct({
    json_schema: Schema.Struct({
      path: pathSchema,
      schema: Schema.Union([Schema.Boolean, Schema.Record(Schema.String, jsonValueSchema)]),
    }),
  }),
  Schema.Struct({ threshold: thresholdSchema }),
  Schema.Struct({ exists: existsCheckSchema }),
  Schema.Struct({
    tool_calls: Schema.Struct({
      name: Schema.optional(Schema.String),
      status: Schema.optional(spanStatusSchema.schema.fields.code),
      count: Schema.optional(nonnegativeIntegerSchema),
      order: Schema.optional(Schema.Array(Schema.String)),
      arguments: Schema.optional(
        Schema.Array(toolArgumentMatcherSchema).check(Schema.isMinLength(1)),
      ),
    }),
  }),
  Schema.Struct({
    spans: Schema.Struct({
      filter: Schema.optional(spanFilterSchema),
      count: Schema.optional(nonnegativeIntegerSchema),
      order: Schema.optional(Schema.Array(Schema.String)),
    }),
  }),
]);

/** Represents a non-recursive assertion check inferred directly from its native union. */
type LeafAssertionCheck = typeof leafAssertionCheckSchema.Type;

/** Represents one structural matcher applied to parsed tool-call arguments. */
type ToolArgumentMatcher = typeof toolArgumentMatcherSchema.Type;

/** Represents the stable trace-span fields accepted by declarative filters. */
type SpanFilter = typeof spanFilterSchema.Type;

/**
 * Gives the recursive branch a finite TypeScript declaration while leaves remain schema-inferred.
 */
type AssertionCheck =
  | LeafAssertionCheck
  | { readonly all: readonly AssertionCheck[] }
  | { readonly any: readonly AssertionCheck[] }
  | { readonly not: AssertionCheck };

/** Recursively encodes the deterministic assertion checks in docs/specs/metric-contract.md. */
const assertionCheckSchema: Schema.Codec<AssertionCheck> = Schema.suspend(() =>
  Schema.Union([
    leafAssertionCheckSchema,
    Schema.Struct({
      all: Schema.Array(assertionCheckSchema).check(Schema.isMinLength(1)),
    }).annotate({ identifier: 'AllAssertionCheck' }),
    Schema.Struct({
      any: Schema.Array(assertionCheckSchema).check(Schema.isMinLength(1)),
    }).annotate({ identifier: 'AnyAssertionCheck' }),
    Schema.Struct({ not: assertionCheckSchema }),
  ]),
);

/** Encodes the normalized metric verdict described by docs/specs/metric-contract.md. */
const metricResultSchema = Schema.Struct({
  score: Schema.Finite.check(Schema.isFinite()),
  pass: Schema.Boolean,
  rationale: Schema.optional(Schema.String),
  details: Schema.optional(jsonValueSchema),
});

/** Represents a validated normalized metric verdict. */
type MetricResult = typeof metricResultSchema.Type;

const metricCaseSchema = Schema.Struct({
  id: Schema.String,
  input: jsonValueSchema,
  expected: Schema.optional(jsonValueSchema),
  params: Schema.optional(Schema.Record(Schema.String, jsonValueSchema)),
});

/** Encodes the executable metric request envelope in docs/specs/metric-contract.md. */
const metricRequestSchema = looseStruct({
  protocol: Schema.Literal(METRIC_PROTOCOL),
  case: metricCaseSchema,
  output: jsonValueSchema,
  trace: Schema.NullOr(traceSchema),
  artifacts: Schema.Array(inlineArtifactSchema),
  // Where a command metric finds the artifacts as files; null when they exist only in the body.
  artifact_dir: Schema.NullOr(Schema.String),
});

/** Represents one validated request to an executable metric. */
type MetricRequest = typeof metricRequestSchema.Type;

/**
 * The runtime's normalized metric vocabulary. Local builds these from metric resources before
 * evaluation, so no schema parses them; authored metrics use metricResourceSchema instead.
 */
type MetricDefinition =
  | { name: string; type: 'assertion'; assert: AssertionCheck[] }
  | { name: string; type: 'exec'; command: string[] }
  | { name: string; type: 'exec'; url: string }
  | { name: string; type: 'judge'; model: string; rubric: string; threshold?: number };

export {
  assertionCheckSchema,
  metricRequestSchema,
  metricResultSchema,
  spanFilterSchema,
  toolArgumentMatcherSchema,
  type AssertionCheck,
  type LeafAssertionCheck,
  type MetricDefinition,
  type MetricRequest,
  type MetricResult,
  type SpanFilter,
  type ToolArgumentMatcher,
};
