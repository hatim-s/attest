import { stripStruct } from '@attest/contracts';
import { caseOutcomeSchema } from '@attest/contracts';
import * as Schema from 'effect/Schema';

/** Case-level verdict derived from invocation and metric outcomes. */
const caseVerdictSchema = Schema.Literals(['pass', 'fail', 'error']);

/** Validates the blob-free case projection shared by servers, report artifacts and browsers. */
const caseSummarySchema = stripStruct({
  caseId: Schema.String,
  suiteName: Schema.String,
  outcome: caseOutcomeSchema,
  verdict: caseVerdictSchema,
  startedAt: Schema.String,
  durationMs: Schema.Finite,
  score: Schema.optional(Schema.Finite),
  metricCounts: stripStruct({
    expected: Schema.Finite,
    evaluated: Schema.Finite,
    passed: Schema.Finite,
    errors: Schema.Finite,
  }),
});

type CaseVerdict = typeof caseVerdictSchema.Type;

type CaseSummary = typeof caseSummarySchema.Type;

export { caseSummarySchema, caseVerdictSchema, type CaseSummary, type CaseVerdict };
