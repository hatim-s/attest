import { z } from 'zod';

import { reportDuplicates } from '../internal/duplicates.js';
import { caseFolderSchema, resourceIdSchema } from '../project/shared.js';

/**
 * A non-empty filter list that rejects repeats. A repeated value selects nothing new, so it is a
 * typo the request should surface instead of the resolver.
 */
const uniqueValuesSchema = (item: z.ZodType<string>, label: string) =>
  z
    .array(item)
    .nonempty()
    .superRefine((values, context) =>
      reportDuplicates({ values, pathFor: (index) => [index], label, context }),
    );

/** The test ids one run selects, as `eval.run` and the dashboard's start request accept them. */
const testIdListSchema = uniqueValuesSchema(resourceIdSchema, 'test id');

/** Requests a seeded sample; the resolved seed is recorded in the run's selection summary. */
const sampleRequestSchema = z.strictObject({
  count: z.number().int().positive(),
  seed: z.string().min(1).optional(),
});

/** Filters intersect; sampling applies once to the combined matching population. */
const caseSelectionSchema = z.strictObject({
  case_ids: uniqueValuesSchema(resourceIdSchema, 'case id').optional(),
  tags: uniqueValuesSchema(z.string().min(1), 'tag').optional(),
  folders: uniqueValuesSchema(caseFolderSchema, 'folder').optional(),
  dataset_ids: uniqueValuesSchema(resourceIdSchema, 'dataset id').optional(),
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
  uniqueValuesSchema,
  testIdListSchema,
  caseSelectionSchema,
  caseSelectionSummarySchema,
  type CaseSelection,
  type CaseSelectionSummary,
};
