import type { JsonValue, Trace } from '@attest/contracts';

import type { CompletedMetricContext } from './metric-evaluation.js';
import { parsePathSegments, type PathSegment } from './internal/path.js';

/** The `$`-rooted document every metric reads, so all metric kinds resolve paths the same way. */
type EvaluationDocument = {
  input: JsonValue;
  output?: JsonValue;
  expected?: JsonValue;
  trace: Trace | null;
};

/** Distinguishes a missing path from a present property whose value is undefined. */
type PathResolution = { found: true; value: unknown } | { found: false };

/** Maps runner state into the stable evaluation document metric paths resolve against. */
const buildEvaluationDocument = (context: CompletedMetricContext): EvaluationDocument => ({
  input: context.caseDefinition.input,
  output: context.execution.output,
  expected: context.caseDefinition.expected,
  trace: context.execution.trace,
});

/** Takes one path step, or undefined when the step leaves the value. */
// BOUNDARY: Trace vendor fields and JSON values are inspected for own path segments without asserting their domain types.
const stepInto = (current: unknown, segment: PathSegment): PathResolution => {
  if (segment.kind === 'index') {
    const value: unknown =
      Array.isArray(current) && Object.hasOwn(current, segment.index)
        ? current[segment.index]
        : undefined;

    return value === undefined ? { found: false } : { found: true, value };
  }

  if (!isRecord(current)) return { found: false };
  const value = Object.hasOwn(current, segment.name) ? current[segment.name] : undefined;

  return value === undefined ? { found: false } : { found: true, value };
};

// BOUNDARY: Arbitrary additive trace fields remain unknown while path traversal validates only object containment and own property presence.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Resolves the narrow `$`-rooted path grammar against any JSON-compatible value. An own property
 * holding undefined counts as missing, because absent optional document fields are undefined.
 */
// BOUNDARY: Evaluation JSON and additive trace fields are traversed only through valid grammar and own property segments.
const resolveValuePath = (value: unknown, path: string): PathResolution => {
  let current: unknown = value;

  for (const segment of parsePathSegments(path)) {
    const resolution = stepInto(current, segment);

    if (!resolution.found) {
      return { found: false };
    }

    current = resolution.value;
  }

  return { found: true, value: current };
};

export { buildEvaluationDocument, resolveValuePath, type EvaluationDocument, type PathResolution };
