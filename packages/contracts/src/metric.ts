import { z } from 'zod';

import { traceSchema } from './trace.js';
import { METRIC_PROTOCOL } from './versions.js';

const pathSchema = z.string().regex(/^\$(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*$/);
type JsonValue = z.infer<ReturnType<typeof z.json>>;

type AssertionCheckValue =
  | { equals: { path: string; value: JsonValue } }
  | { contains: { path: string; value: JsonValue } }
  | { regex: { path: string; pattern: string } }
  | { json_schema: { path: string; schema: boolean | Record<string, JsonValue> } }
  | {
      threshold: {
        path: string;
        lt?: number;
        lte?: number;
        gt?: number;
        gte?: number;
      };
    }
  | { exists: { path: string } }
  | {
      tool_calls: {
        name?: string;
        status?: 'ok' | 'error';
        count?: number;
        order?: string[];
      };
    }
  | { all: AssertionCheckValue[] }
  | { any: AssertionCheckValue[] }
  | { not: AssertionCheckValue };

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
  });

/**
 * Recursively encodes the deterministic assertion checks in docs/specs/metric-contract.md.
 */
const assertionCheckSchema: z.ZodType<AssertionCheckValue> = z.lazy(() =>
  z.union([
    z.strictObject({ equals: z.strictObject({ path: pathSchema, value: z.json() }) }),
    z.strictObject({ contains: z.strictObject({ path: pathSchema, value: z.json() }) }),
    z.strictObject({
      regex: z.strictObject({
        path: pathSchema,
        // RE2-safety is enforced by the assertion engine at evaluation time.
        pattern: z.string().refine((pattern) => {
          try {
            new RegExp(pattern);
            return true;
          } catch {
            return false;
          }
        }, 'pattern must be a valid regular expression'),
      }),
    }),
    z.strictObject({
      json_schema: z.strictObject({
        path: pathSchema,
        schema: z.union([z.boolean(), z.record(z.string(), z.json())]),
      }),
    }),
    z.strictObject({ threshold: thresholdSchema }),
    z.strictObject({ exists: z.strictObject({ path: pathSchema }) }),
    z.strictObject({
      tool_calls: z.strictObject({
        name: z.string().optional(),
        status: z.enum(['ok', 'error']).optional(),
        count: z.number().int().nonnegative().optional(),
        order: z.array(z.string()).optional(),
      }),
    }),
    z.strictObject({ all: z.array(assertionCheckSchema) }),
    z.strictObject({ any: z.array(assertionCheckSchema) }),
    z.strictObject({ not: assertionCheckSchema }),
  ]),
);

/** Encodes the normalized metric verdict described by docs/specs/metric-contract.md. */
const metricResultSchema = z.strictObject({
  score: z.number().finite(),
  pass: z.boolean(),
  rationale: z.string().optional(),
  details: z.json().optional(),
});

/** Represents a validated normalized metric verdict. */
type MetricResult = z.infer<typeof metricResultSchema>;

const metricCaseSchema = z.strictObject({
  id: z.string(),
  input: z.json(),
  expected: z.json().optional(),
  params: z.record(z.string(), z.json()).optional(),
});

/** Encodes the executable metric request envelope in docs/specs/metric-contract.md. */
const metricRequestSchema = z.looseObject({
  protocol: z.literal(METRIC_PROTOCOL),
  case: metricCaseSchema,
  output: z.json(),
  trace: traceSchema.nullable(),
});

/** Represents one validated request to an executable metric. */
type MetricRequest = z.infer<typeof metricRequestSchema>;

const assertionMetricDefinitionSchema = z.strictObject({
  name: z.string(),
  type: z.literal('assertion'),
  assert: z.array(assertionCheckSchema),
});

const executableMetricDefinitionSchema = z
  .strictObject({
    name: z.string(),
    type: z.literal('exec'),
    command: z.array(z.string()).nonempty().optional(),
    url: z.url().optional(),
  })
  .superRefine((definition, context) => {
    const hasCommand = definition.command !== undefined;
    const hasUrl = definition.url !== undefined;
    if (hasCommand !== hasUrl) {
      return;
    }

    context.addIssue({
      code: 'custom',
      path: ['command'],
      message: 'exactly one of command or url must be present',
    });
  });

const judgeMetricDefinitionSchema = z.strictObject({
  name: z.string(),
  type: z.literal('judge'),
  model: z.string(),
  rubric: z.string(),
  threshold: z.number().finite().optional(),
});

/** Encodes all metric definition variants from docs/specs/metric-contract.md. */
const metricDefinitionSchema = z.discriminatedUnion('type', [
  assertionMetricDefinitionSchema,
  executableMetricDefinitionSchema,
  judgeMetricDefinitionSchema,
]);

/** Represents a validated assertion, executable, or judge metric definition. */
type MetricDefinition = z.infer<typeof metricDefinitionSchema>;

export {
  assertionCheckSchema,
  metricDefinitionSchema,
  metricRequestSchema,
  metricResultSchema,
  type MetricDefinition,
  type MetricRequest,
  type MetricResult,
};
