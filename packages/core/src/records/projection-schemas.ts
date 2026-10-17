import { caseOutcomeSchema } from '@attest/contracts';
import { z } from 'zod';

/** Case-level verdict derived from invocation and metric outcomes. */
const caseVerdictSchema = z.enum(['pass', 'fail', 'error']);

/** Validates the blob-free case projection shared by servers, report artifacts and browsers. */
const caseSummarySchema = z.object({
  caseId: z.string(),
  suiteName: z.string(),
  outcome: caseOutcomeSchema,
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
});

type CaseVerdict = z.infer<typeof caseVerdictSchema>;

type CaseSummary = z.infer<typeof caseSummarySchema>;

export { caseSummarySchema, caseVerdictSchema, type CaseSummary, type CaseVerdict };
