import * as SchemaGetter from 'effect/SchemaGetter';
import { stripStruct } from '@attest/contracts';
import * as Schema from 'effect/Schema';
import {
  pageQuerySchema as corePageQuerySchema,
  projectKeySchema,
  runStartRequestSchema,
} from '@attest/core/records';

const idSchema = Schema.String.check(Schema.isMinLength(1));

const projectParamsSchema = stripStruct({ projectKey: projectKeySchema });

const runParamsSchema = stripStruct({ ...projectParamsSchema.from.schema.fields, runId: idSchema });

const caseParamsSchema = stripStruct({
  ...runParamsSchema.from.schema.fields,
  suiteName: idSchema,
  caseId: idSchema,
});

const diffParamsSchema = stripStruct({
  ...projectParamsSchema.from.schema.fields,
  baseRunId: idSchema,
  candidateRunId: idSchema,
}).check(
  Schema.makeFilter((params) => params.baseRunId !== params.candidateRunId, {
    message: 'baseRunId and candidateRunId must differ.',
  }),
);

// Number() preserves the existing HTTP coercion of empty strings, booleans and null.
const coercedNumberSchema = Schema.Unknown.pipe(
  Schema.decodeTo(Schema.Finite, {
    decode: SchemaGetter.transform((value) => Number(value)),
    encode: SchemaGetter.passthrough(),
  }),
);

const pageQuerySchema = stripStruct({
  ...corePageQuerySchema.from.schema.fields,
  limit: Schema.optional(coercedNumberSchema).pipe(
    Schema.decodeTo(corePageQuerySchema.from.schema.fields.limit),
  ),
});

const evalParamsSchema = stripStruct({
  ...projectParamsSchema.from.schema.fields,
  suiteName: idSchema,
});

const caseHistoryParamsSchema = stripStruct({
  ...evalParamsSchema.from.schema.fields,
  caseId: idSchema,
});

const caseSummariesQuerySchema = stripStruct({
  ...pageQuerySchema.from.schema.fields,
  suiteName: Schema.optional(idSchema),
});

// The store owns timestamp and interval rules (`canonicalTime`, `activityBounds`); the edge only
// requires the fields to be present.
const evalRunsQuerySchema = stripStruct({
  ...pageQuerySchema.from.schema.fields,
  since: Schema.optional(idSchema),
  until: Schema.optional(idSchema),
});

const activityQuerySchema = stripStruct({ from: idSchema, to: idSchema });

type CaseSummariesQuery = Partial<typeof caseSummariesQuerySchema.Type>;

type EvalRunsQuery = Partial<typeof evalRunsQuerySchema.Type>;

type ActivityQuery = typeof activityQuerySchema.Type;

export {
  projectParamsSchema,
  runParamsSchema,
  caseParamsSchema,
  diffParamsSchema,
  pageQuerySchema,
  evalParamsSchema,
  caseHistoryParamsSchema,
  caseSummariesQuerySchema,
  evalRunsQuerySchema,
  activityQuerySchema,
  runStartRequestSchema,
  type CaseSummariesQuery,
  type EvalRunsQuery,
  type ActivityQuery,
};
