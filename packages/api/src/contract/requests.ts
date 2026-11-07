import * as SchemaGetter from 'effect/SchemaGetter';
import * as Effect from 'effect/Effect';
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

const suiteParamsSchema = stripStruct({
  ...projectParamsSchema.from.schema.fields,
  suiteName: idSchema,
});

const MAX_SUITE_HISTORY_RUNS = 50;

const DEFAULT_SUITE_HISTORY_RUNS = 20;

const suiteHistoryQuerySchema = stripStruct({
  limit: coercedNumberSchema
    .check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(1))
    .check(Schema.isLessThanOrEqualTo(MAX_SUITE_HISTORY_RUNS))
    .pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_SUITE_HISTORY_RUNS))),
});

const suiteHistoryRequestSchema = stripStruct({
  ...suiteParamsSchema.from.schema.fields,
  ...suiteHistoryQuerySchema.from.schema.fields,
});

type SuiteHistoryQuery = Partial<typeof suiteHistoryQuerySchema.Type>;

export {
  projectParamsSchema,
  runParamsSchema,
  caseParamsSchema,
  diffParamsSchema,
  pageQuerySchema,
  suiteParamsSchema,
  suiteHistoryQuerySchema,
  suiteHistoryRequestSchema,
  MAX_SUITE_HISTORY_RUNS,
  DEFAULT_SUITE_HISTORY_RUNS,
  runStartRequestSchema,
  type SuiteHistoryQuery,
};
