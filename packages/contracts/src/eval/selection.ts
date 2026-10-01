import { z } from 'zod';

import { caseFolderSchema, resourceIdSchema } from '../project/shared.js';

/** Requests a seeded sample; the resolved seed is recorded in the run's selection summary. */
const sampleRequestSchema = z.strictObject({
  count: z.number().int().positive(),
  seed: z.string().min(1).optional(),
});

/** Filters intersect; sampling applies once to the combined matching population. */
const caseSelectionSchema = z.strictObject({
  case_ids: z.array(resourceIdSchema).nonempty().optional(),
  tags: z.array(z.string().min(1)).nonempty().optional(),
  folders: z.array(caseFolderSchema).nonempty().optional(),
  dataset_ids: z.array(resourceIdSchema).nonempty().optional(),
  sample: sampleRequestSchema.optional(),
});

/** Records selection coverage and the resolved sampling seed for an immutable run. */
const caseSelectionSummarySchema = z
  .strictObject({
    total_cases: z.number().int().nonnegative(),
    matched_cases: z.number().int().nonnegative(),
    selected_cases: z.number().int().nonnegative(),
    sample: sampleRequestSchema
      .extend({ seed: z.string().min(1), algorithm: z.literal('hash-rank-v1') })
      .optional(),
  })
  .refine(
    (value) =>
      value.selected_cases <= value.matched_cases && value.matched_cases <= value.total_cases,
    'Selected counts must not exceed matched or total counts.',
  );

type CaseSelection = z.infer<typeof caseSelectionSchema>;
type CaseSelectionSummary = z.infer<typeof caseSelectionSummarySchema>;

export {
  caseSelectionSchema,
  caseSelectionSummarySchema,
  type CaseSelection,
  type CaseSelectionSummary,
};
