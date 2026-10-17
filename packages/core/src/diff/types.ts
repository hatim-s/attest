import { z } from 'zod';

import { caseVerdictSchema } from '../records/projection-schemas.js';

/** Exhaustive transition classification for a case across two runs. */
const caseTransitionKindSchema = z.enum([
  'added',
  'removed',
  'fixed',
  'regressed',
  'still_passing',
  'still_failing',
]);

const metricDeltaSchema = z.object({
  metricName: z.string(),
  baseScore: z.number().optional(),
  candidateScore: z.number().optional(),
  delta: z.number().optional(),
  passTransition: z.enum(['unchanged', 'gained', 'lost']),
});

const caseTransitionSchema = z.object({
  suiteName: z.string(),
  caseId: z.string(),
  kind: caseTransitionKindSchema,
  // Marks a comparable pass/fail verdict flip whose metric scores are indistinguishable.
  flakiness: z.literal('suspected').optional(),
  baseVerdict: caseVerdictSchema.optional(),
  candidateVerdict: caseVerdictSchema.optional(),
  metricDeltas: z.array(metricDeltaSchema),
});

const diffSummarySchema = z.object({
  baseRunId: z.string(),
  candidateRunId: z.string(),
  baseConfigHash: z.string(),
  candidateConfigHash: z.string(),
  counts: z.record(caseTransitionKindSchema, z.number()),
  flakySuspectCount: z.number(),
  basePassRate: z.number(),
  candidatePassRate: z.number(),
  // Partial runs compare only shared recorded identities; unmatched cases are coverage differences.
  coverage: z
    .object({
      sharedCases: z.number(),
      baseOnlyCases: z.number(),
      candidateOnlyCases: z.number(),
    })
    .optional(),
});

/** Validates the complete run comparison projection without importing comparison or storage code. */
const runDiffSchema = z.object({
  summary: diffSummarySchema,
  transitions: z.array(caseTransitionSchema),
});

type CaseTransitionKind = z.infer<typeof caseTransitionKindSchema>;

type MetricDelta = z.infer<typeof metricDeltaSchema>;

type CaseTransition = z.infer<typeof caseTransitionSchema>;

type DiffSummary = z.infer<typeof diffSummarySchema>;

type RunDiff = z.infer<typeof runDiffSchema>;

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
