import { z } from 'zod';

import { traceSchema } from './trace.js';
import { METRIC_PROTOCOL } from './versions.js';

const jsonValueSchema = z.json();

/** Represents the JSON values accepted at contract boundaries. */
type JsonValue = z.infer<typeof jsonValueSchema>;

const pathSchema = z.string().regex(/^\$(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*$/);
// 'g' and 'y' are deliberately excluded: they make RegExp.test stateful via lastIndex,
// which would turn assertion evaluation order into a correctness hazard.
const regularExpressionFlagsSchema = z.string().regex(/^[dimsuv]*$/);

/**
 * Checks JavaScript regular-expression syntax from docs/specs/metric-contract.md.
 * The engine enforces a per-check time guard at evaluation; syntax is checked here.
 */
const isValidRegularExpression = (value: { pattern: string; flags?: string }): boolean => {
  try {
    new RegExp(value.pattern, value.flags);
    return true;
  } catch {
    return false;
  }
};

const regexCheckSchema = z
  .strictObject({
    path: pathSchema,
    pattern: z.string(),
    flags: regularExpressionFlagsSchema.optional(),
  })
  .refine(isValidRegularExpression, 'pattern and flags must form a valid regular expression');

const thresholdSchema = z
  .strictObject({
    path: pathSchema,
    lt: z.number().finite().optional(),
    lte: z.number().finite().optional(),
    gt: z.number().finite().optional(),
    gte: z.number().finite().optional(),
  })
  .superRefine((threshold, context) => {
    const comparisons = [threshold.lt, threshold.lte, threshold.gt, threshold.gte];
    if (comparisons.some((comparison) => comparison !== undefined)) {
      return;
    }

    context.addIssue({
      code: 'custom',
      path: ['lt'],
      message: 'at least one threshold comparison is required',
    });
  })
  .meta({ id: 'Threshold' });

const equalsCheckSchema = z.strictObject({ path: pathSchema, value: jsonValueSchema });
const containsCheckSchema = z.strictObject({ path: pathSchema, value: jsonValueSchema });
const existsCheckSchema = z.strictObject({ path: pathSchema });

const toolArgumentMatcherSchema = z.union([
  z.strictObject({ equals: equalsCheckSchema }),
  z.strictObject({ contains: containsCheckSchema }),
  z.strictObject({ exists: existsCheckSchema }),
]);

/** Matches trace spans through stable core fields and a partial attribute map. */
const spanFilterSchema = z.strictObject({
  kind: z.enum(['agent', 'llm', 'tool', 'retrieval', 'other']).optional(),
  name: z.string().optional(),
  status: z.enum(['ok', 'error']).optional(),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

const leafAssertionCheckSchema = z.union([
  z.strictObject({ equals: equalsCheckSchema }),
  z.strictObject({ contains: containsCheckSchema }),
  z.strictObject({ regex: regexCheckSchema }),
  z.strictObject({
    json_schema: z.strictObject({
      path: pathSchema,
      schema: z.union([z.boolean(), z.record(z.string(), jsonValueSchema)]),
    }),
  }),
  z.strictObject({ threshold: thresholdSchema }),
  z.strictObject({ exists: existsCheckSchema }),
  z.strictObject({
    tool_calls: z.strictObject({
      name: z.string().optional(),
      status: z.enum(['ok', 'error']).optional(),
      count: z.number().int().nonnegative().optional(),
      order: z.array(z.string()).optional(),
      arguments: z.array(toolArgumentMatcherSchema).nonempty().optional(),
    }),
  }),
  z.strictObject({
    spans: z.strictObject({
      filter: spanFilterSchema.optional(),
      count: z.number().int().nonnegative().optional(),
      order: z.array(z.string()).optional(),
    }),
  }),
]);

/** Represents a non-recursive assertion check inferred directly from its Zod union. */
type LeafAssertionCheck = z.infer<typeof leafAssertionCheckSchema>;

/** Represents one structural matcher applied to parsed tool-call arguments. */
type ToolArgumentMatcher = z.infer<typeof toolArgumentMatcherSchema>;

/** Represents the stable trace-span fields accepted by declarative filters. */
type SpanFilter = z.infer<typeof spanFilterSchema>;

/**
 * Represents recursive combinators whose self-reference requires an explicit TypeScript layer.
 */
type AssertionCheck =
  | LeafAssertionCheck
  | { all: AssertionCheck[] }
  | { any: AssertionCheck[] }
  | { not: AssertionCheck };

/**
 * Recursively encodes the deterministic assertion checks in docs/specs/metric-contract.md.
 */
const assertionCheckSchema: z.ZodType<AssertionCheck> = z.lazy(() => {
  const allAssertionCheckSchema = z
    .strictObject({ all: z.array(assertionCheckSchema).nonempty() })
    .meta({ id: 'AllAssertionCheck' });
  const anyAssertionCheckSchema = z
    .strictObject({ any: z.array(assertionCheckSchema).nonempty() })
    .meta({ id: 'AnyAssertionCheck' });

  return z.union([
    leafAssertionCheckSchema,
    allAssertionCheckSchema,
    anyAssertionCheckSchema,
    z.strictObject({ not: assertionCheckSchema }),
  ]);
});

/** Encodes the normalized metric verdict described by docs/specs/metric-contract.md. */
const metricResultSchema = z.strictObject({
  score: z.number().finite(),
  pass: z.boolean(),
  rationale: z.string().optional(),
  details: jsonValueSchema.optional(),
});

/** Represents a validated normalized metric verdict. */
type MetricResult = z.infer<typeof metricResultSchema>;

const metricCaseSchema = z.strictObject({
  id: z.string(),
  input: jsonValueSchema,
  expected: jsonValueSchema.optional(),
  params: z.record(z.string(), jsonValueSchema).optional(),
});

/** Encodes the executable metric request envelope in docs/specs/metric-contract.md. */
const metricRequestSchema = z.looseObject({
  protocol: z.literal(METRIC_PROTOCOL),
  case: metricCaseSchema,
  output: jsonValueSchema,
  trace: traceSchema.nullable(),
});

/** Represents one validated request to an executable metric. */
type MetricRequest = z.infer<typeof metricRequestSchema>;

const assertionMetricDefinitionSchema = z
  .strictObject({
    name: z.string(),
    type: z.literal('assertion'),
    assert: z.array(assertionCheckSchema).nonempty(),
  })
  .meta({ id: 'AssertionMetricDefinition' });

const executableCommandMetricDefinitionSchema = z.strictObject({
  name: z.string(),
  type: z.literal('exec'),
  command: z.array(z.string()).nonempty(),
});

const executableHttpMetricDefinitionSchema = z.strictObject({
  name: z.string(),
  type: z.literal('exec'),
  url: z.url(),
});

const executableMetricDefinitionSchema = z
  .union([executableCommandMetricDefinitionSchema, executableHttpMetricDefinitionSchema], {
    error: 'exactly one of command or url must be present',
  })
  .meta({ id: 'ExecutableMetricDefinition' });

const judgeMetricDefinitionSchema = z.strictObject({
  name: z.string(),
  type: z.literal('judge'),
  model: z.string(),
  rubric: z.string(),
  threshold: z.number().finite().optional(),
});

/** Encodes all metric definition variants from docs/specs/metric-contract.md. */
const metricDefinitionSchema = z.union([
  assertionMetricDefinitionSchema,
  executableMetricDefinitionSchema,
  judgeMetricDefinitionSchema,
]);

/** Represents a validated assertion, executable, or judge metric definition. */
type MetricDefinition = z.infer<typeof metricDefinitionSchema>;

export {
  assertionCheckSchema,
  isValidRegularExpression,
  leafAssertionCheckSchema,
  metricDefinitionSchema,
  metricRequestSchema,
  metricResultSchema,
  spanFilterSchema,
  toolArgumentMatcherSchema,
  type AssertionCheck,
  type JsonValue,
  type LeafAssertionCheck,
  type MetricDefinition,
  type MetricRequest,
  type MetricResult,
  type SpanFilter,
  type ToolArgumentMatcher,
};
