import type { JsonValue, Trace } from '@attest/contracts';

import type { MetricContext } from './metric-evaluation.js';
import { parsePathSegments } from './internal/path.js';

/** Defines the `$`-rooted document every metric reads so all metric kinds share spec §Paths semantics. */
type EvaluationDocument = {
  input: JsonValue;
  output: JsonValue | undefined;
  expected: JsonValue | undefined;
  trace: Trace | null;
};

/** Distinguishes a missing path from a present property whose value is undefined. */
type PathResolution = { found: true; value: unknown } | { found: false };

/** Maps runner state into the stable evaluation document described by spec §Paths. */
const buildEvaluationDocument = (context: MetricContext): EvaluationDocument => ({
  input: context.caseDefinition.input,
  output: context.execution.outcome === 'completed' ? context.execution.output : undefined,
  expected: context.caseDefinition.expected,
  trace: context.execution.trace,
});

/** Resolves only the intentionally narrow dot-field and array-index grammar from spec §Paths. */
const resolveDocumentPath = (document: EvaluationDocument, path: string): PathResolution => {
  let current: unknown = document;

  for (const segment of parsePathSegments(path)) {
    if (segment.kind === 'index') {
      if (!Array.isArray(current) || !Object.hasOwn(current, segment.index)) {
        return { found: false };
      }
      current = current[segment.index];
      continue;
    }

    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return { found: false };
    }
    if (!Object.hasOwn(current, segment.name)) {
      return { found: false };
    }
    current = (current as Record<string, unknown>)[segment.name];
  }

  return { found: true, value: current };
};

export {
  buildEvaluationDocument,
  resolveDocumentPath,
  type EvaluationDocument,
  type PathResolution,
};
