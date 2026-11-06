import { stripStruct } from '@attest/contracts';
import * as Schema from 'effect/Schema';

import { caseVerdictSchema } from '../records/projection-schemas.js';

/** Exhaustive transition classification for a case across two runs. */
const caseTransitionKindSchema = Schema.Literals([
  'added',
  'removed',
  'fixed',
  'regressed',
  'still_passing',
  'still_failing',
]);

const metricDeltaSchema = stripStruct({
  metricName: Schema.String,
  baseScore: Schema.optional(Schema.Finite),
  candidateScore: Schema.optional(Schema.Finite),
  delta: Schema.optional(Schema.Finite),
  passTransition: Schema.Literals(['unchanged', 'gained', 'lost']),
});

const caseTransitionSchema = stripStruct({
  suiteName: Schema.String,
  caseId: Schema.String,
  kind: caseTransitionKindSchema,
  // Marks a comparable pass/fail verdict flip whose metric scores are indistinguishable.
  flakiness: Schema.optional(Schema.Literal('suspected')),
  baseVerdict: Schema.optional(caseVerdictSchema),
  candidateVerdict: Schema.optional(caseVerdictSchema),
  metricDeltas: Schema.Array(metricDeltaSchema),
});

const diffSummarySchema = stripStruct({
  baseRunId: Schema.String,
  candidateRunId: Schema.String,
  baseConfigHash: Schema.String,
  candidateConfigHash: Schema.String,
  counts: Schema.Record(caseTransitionKindSchema, Schema.Finite),
  flakySuspectCount: Schema.Finite,
  basePassRate: Schema.Finite,
  candidatePassRate: Schema.Finite,
  // Partial runs compare only shared recorded identities; unmatched cases are coverage differences.
  coverage: Schema.optional(
    stripStruct({
      sharedCases: Schema.Finite,
      baseOnlyCases: Schema.Finite,
      candidateOnlyCases: Schema.Finite,
    }),
  ),
});

/** Validates the complete run comparison projection without importing comparison or storage code. */
const runDiffSchema = stripStruct({
  summary: diffSummarySchema,
  transitions: Schema.Array(caseTransitionSchema),
});

type CaseTransitionKind = typeof caseTransitionKindSchema.Type;

type MetricDelta = typeof metricDeltaSchema.Type;

type CaseTransition = typeof caseTransitionSchema.Type;

type DiffSummary = typeof diffSummarySchema.Type;

type RunDiff = typeof runDiffSchema.Type;

/** Identifies the two runs being compared and whether only shared cases count. */
interface RunComparison {
  baseRunId: string;
  candidateRunId: string;
  baseConfigHash: string;
  candidateConfigHash: string;
  /** Partial selections compare only cases both runs recorded. */
  sharedOnly?: boolean;
}

export {
  runDiffSchema,
  type CaseTransition,
  type CaseTransitionKind,
  type DiffSummary,
  type MetricDelta,
  type RunComparison,
  type RunDiff,
};
