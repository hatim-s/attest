import { positiveIntegerSchema, nonnegativeIntegerSchema } from '../schema/scalars.js';
import * as Schema from 'effect/Schema';

import { reportDuplicates } from '../internal/duplicates.js';
import { caseFolderSchema, resourceIdSchema } from '../project/shared.js';

/**
 * A non-empty filter list that rejects repeats. A repeated value selects nothing new, so it is a
 * typo the request should surface instead of the resolver.
 */
const uniqueValuesSchema = (item: Schema.Codec<string>, label: string) =>
  Schema.Array(item)
    .check(Schema.isMinLength(1))
    .check(
      Schema.makeFilter((values) => {
        const context: Schema.FilterIssue[] = [];
        reportDuplicates({ values, pathFor: (index) => [index], label, context });

        return context;
      }),
    );

/** The test ids one run selects, as `eval.run` and the dashboard's start request accept them. */
const testIdListSchema = uniqueValuesSchema(resourceIdSchema, 'test id');

/** Requests a seeded sample; the resolved seed is recorded in the run's selection summary. */
const sampleRequestSchema = Schema.Struct({
  count: positiveIntegerSchema,
  seed: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
});

/** Filters intersect; sampling applies once to the combined matching population. */
const caseSelectionSchema = Schema.Struct({
  case_ids: Schema.optional(uniqueValuesSchema(resourceIdSchema, 'case id')),
  tags: Schema.optional(uniqueValuesSchema(Schema.String.check(Schema.isMinLength(1)), 'tag')),
  folders: Schema.optional(uniqueValuesSchema(caseFolderSchema, 'folder')),
  dataset_ids: Schema.optional(uniqueValuesSchema(resourceIdSchema, 'dataset id')),
  sample: Schema.optional(sampleRequestSchema),
});

/** Records selection coverage and the resolved sampling seed for an immutable run. */
const caseSelectionSummarySchema = Schema.Struct({
  total_cases: nonnegativeIntegerSchema,
  matched_cases: nonnegativeIntegerSchema,
  selected_cases: nonnegativeIntegerSchema,
  sample: Schema.optional(
    Schema.Struct({
      ...sampleRequestSchema.fields,
      seed: Schema.String.check(Schema.isMinLength(1)),
      algorithm: Schema.Literal('hash-rank-v1'),
    }),
  ),
}).check(
  Schema.makeFilter((value) =>
    value.selected_cases <= value.matched_cases && value.matched_cases <= value.total_cases
      ? undefined
      : 'Selected counts must not exceed matched or total counts.',
  ),
);

type CaseSelection = typeof caseSelectionSchema.Type;

type CaseSelectionSummary = typeof caseSelectionSummarySchema.Type;

export {
  uniqueValuesSchema,
  testIdListSchema,
  caseSelectionSchema,
  caseSelectionSummarySchema,
  type CaseSelection,
  type CaseSelectionSummary,
};
