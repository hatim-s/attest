import type { JsonValue, Trace } from '@attest/contracts';

import type { CompletedMetricContext } from './metric-evaluation.js';
import { parsePathSegments, type PathSegment } from './internal/path.js';

/** Defines the `$`-rooted document every metric reads so all metric kinds share spec §Paths semantics. */
type EvaluationDocument = {
  input: JsonValue;
  output?: JsonValue;
  expected?: JsonValue;
  trace: Trace | null;
};

/** Distinguishes a missing path from a present property whose value is undefined. */
type PathResolution = { found: true; value: unknown } | { found: false };

/** Maps runner state into the stable evaluation document described by spec §Paths. */
const buildEvaluationDocument = (context: CompletedMetricContext): EvaluationDocument => ({
  input: context.caseDefinition.input,
  output: context.execution.output,
  expected: context.caseDefinition.expected,
  trace: context.execution.trace,
});

/** Takes one path step, or undefined when the step leaves the value. */
const stepInto = (current: unknown, segment: PathSegment): unknown => {
  if (segment.kind === 'index') {
    return Array.isArray(current) && Object.hasOwn(current, segment.index)
      ? current[segment.index]
      : undefined;
  }
  if (current === null || typeof current !== 'object' || Array.isArray(current)) {
    return undefined;
  }
  return Object.hasOwn(current, segment.name)
    ? (current as Record<string, unknown>)[segment.name]
    : undefined;
};

/**
 * Resolves the narrow `$`-rooted path grammar against any JSON-compatible value. An own property
 * holding undefined counts as missing, because absent optional document fields are undefined.
 */
const resolveValuePath = (value: unknown, path: string): PathResolution => {
  let current: unknown = value;
  for (const segment of parsePathSegments(path)) {
    current = stepInto(current, segment);
    if (current === undefined) {
      return { found: false };
    }
  }
  return { found: true, value: current };
};

export { buildEvaluationDocument, resolveValuePath, type EvaluationDocument, type PathResolution };
