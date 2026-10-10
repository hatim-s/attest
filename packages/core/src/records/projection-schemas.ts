import { z } from 'zod';

import type { RunDiff } from '../diff/types.js';
import type { CaseSummary } from '../store/types.js';

const caseVerdictSchema = z.enum(['pass', 'fail', 'error']);

/** Validates the blob-free case projection shared by servers, report artifacts and browsers. */
const caseSummarySchema = z.object({
  caseId: z.string(),
  suiteName: z.string(),
  outcome: z.enum(['completed', 'invocation_error', 'timeout', 'cancelled']),
  verdict: caseVerdictSchema,
  startedAt: z.string(),
  durationMs: z.number(),
  score: z.number().optional(),
  metricCounts: z.object({
    expected: z.number(),
    evaluated: z.number(),
    passed: z.number(),
    errors: z.number(),
  }),
}) satisfies z.ZodType<CaseSummary>;

const transitionKinds = [
  'added',
  'removed',
  'fixed',
  'regressed',
  'still_passing',
  'still_failing',
] as const;

/** Validates the complete run comparison projection without importing comparison or storage code. */
const runDiffSchema = z.object({
  summary: z.object({
    baseRunId: z.string(),
    candidateRunId: z.string(),
    baseConfigHash: z.string(),
    candidateConfigHash: z.string(),
    counts: z.object({
      added: z.number(),
      removed: z.number(),
      fixed: z.number(),
      regressed: z.number(),
      still_passing: z.number(),
      still_failing: z.number(),
    }),
    flakySuspectCount: z.number(),
    basePassRate: z.number(),
    candidatePassRate: z.number(),
    coverage: z
      .object({
        sharedCases: z.number(),
        baseOnlyCases: z.number(),
        candidateOnlyCases: z.number(),
      })
      .optional(),
  }),
  transitions: z.array(
    z.object({
      suiteName: z.string(),
      caseId: z.string(),
      kind: z.enum(transitionKinds),
      flakiness: z.literal('suspected').optional(),
      baseVerdict: caseVerdictSchema.optional(),
      candidateVerdict: caseVerdictSchema.optional(),
      metricDeltas: z.array(
        z.object({
          metricName: z.string(),
          baseScore: z.number().optional(),
          candidateScore: z.number().optional(),
          delta: z.number().optional(),
          passTransition: z.enum(['unchanged', 'gained', 'lost']),
        }),
      ),
    }),
  ),
}) satisfies z.ZodType<RunDiff>;

export { caseSummarySchema, runDiffSchema };
