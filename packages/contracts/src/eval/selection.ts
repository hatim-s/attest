import { z } from 'zod';
import { resourceIdSchema } from '../project/shared.js';

// Segments allow internal spaces but exclude whitespace at either end and dot traversal.
const folderSegment = String.raw`(?!\.{1,2}(?:/|$))[^\s/\\](?:[^/\\]*[^\s/\\])?`;

/** Logical folder validation is also emitted in the public JSON schemas. */
const caseFolderSchema = z
  .string()
  .min(1)
  .regex(
    new RegExp(String.raw`^${folderSegment}(?:/${folderSegment})*(?![\s\S])`, 'u'),
    'Use non-empty slash-separated folder names without dot segments or backslashes.',
  );

/** Filters intersect; sampling applies once to the combined matching population. */
const caseSelectionSchema = z.strictObject({
  case_ids: z.array(resourceIdSchema).nonempty().optional(),
  tags: z.array(z.string().min(1)).nonempty().optional(),
  folders: z.array(caseFolderSchema).nonempty().optional(),
  dataset_ids: z.array(resourceIdSchema).nonempty().optional(),
  sample: z
    .strictObject({
      count: z.number().int().positive(),
      seed: z.string().min(1).optional(),
    })
    .optional(),
});

/** Records selection coverage and the resolved sampling seed for an immutable run. */
const caseSelectionSummarySchema = z
  .strictObject({
    total_cases: z.number().int().nonnegative(),
    matched_cases: z.number().int().nonnegative(),
    selected_cases: z.number().int().nonnegative(),
    sample: z
      .strictObject({
        count: z.number().int().positive(),
        seed: z.string().min(1),
        algorithm: z.literal('hash-rank-v1'),
      })
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
  caseFolderSchema,
  caseSelectionSchema,
  caseSelectionSummarySchema,
  type CaseSelection,
  type CaseSelectionSummary,
};
