import type { JsonValue, Trace } from '@attest/contracts';

import type { MetricContext } from './metric-evaluation.js';
import { parsePathSegments } from './internal/path.js';

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
const buildEvaluationDocument = (context: MetricContext): EvaluationDocument => ({
  input: context.caseDefinition.input,
  ...(context.execution.outcome === 'completed' ? { output: context.execution.output } : {}),
  ...(context.caseDefinition.expected !== undefined
    ? { expected: context.caseDefinition.expected }
    : {}),
  trace: context.execution.trace,
});

/** Resolves the narrow `$`-rooted path grammar against any JSON-compatible value. */
const resolveValuePath = (value: unknown, path: string): PathResolution => {
  let current: unknown = value;

  for (const segment of parsePathSegments(path)) {
    if (segment.kind === 'index') {
      if (!Array.isArray(current) || !Object.hasOwn(current, segment.index)) {
        return { found: false };
      }
      current = current[segment.index];
      if (current === undefined) {
        return { found: false };
      }
      continue;
    }

    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return { found: false };
    }
    if (!Object.hasOwn(current, segment.name)) {
      return { found: false };
    }
    current = (current as Record<string, unknown>)[segment.name];
    // Evaluation documents omit absent optional fields; treat an externally supplied own `undefined` identically.
    if (current === undefined) {
      return { found: false };
    }
  }

  return { found: true, value: current };
};

/** Resolves a metric path against the canonical evaluation document. */
const resolveDocumentPath = (document: EvaluationDocument, path: string): PathResolution =>
  resolveValuePath(document, path);

export {
  buildEvaluationDocument,
  resolveDocumentPath,
  resolveValuePath,
  type EvaluationDocument,
  type PathResolution,
};
