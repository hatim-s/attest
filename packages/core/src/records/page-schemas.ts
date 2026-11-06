import * as Effect from 'effect/Effect';
import { stripStruct } from '@attest/contracts';
import { parseWithSchema } from '@attest/contracts';
import * as Schema from 'effect/Schema';

import { StoreError } from '../store/store-error.js';
import { runRecordSchema } from '../store/internal/record-schema.js';
import { caseSummarySchema } from './projection-schemas.js';

const DEFAULT_PAGE_LIMIT = 100;

const MAX_PAGE_LIMIT = 1_000;

/** Keeps typed store reads and coerced HTTP queries on the same page bounds. */
const isValidPageLimit = (limit: number): boolean =>
  Number.isInteger(limit) && limit >= 1 && limit <= MAX_PAGE_LIMIT;

const pageQuerySchema = stripStruct({
  cursor: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  limit: Schema.Finite.check(
    Schema.makeFilter(isValidPageLimit, {
      message: `Page limit must be an integer from 1 to ${MAX_PAGE_LIMIT}.`,
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_PAGE_LIMIT))),
});

const cursorSchema = Schema.String.check(Schema.isMinLength(1));

const runPageSchema = stripStruct({
  items: Schema.Array(runRecordSchema),
  nextCursor: Schema.optional(cursorSchema),
});

const caseSummaryPageSchema = stripStruct({
  items: Schema.Array(caseSummarySchema),
  nextCursor: Schema.optional(cursorSchema),
});

/** Cursors are opaque to callers; each source decides what one encodes. */
type PageQuery = typeof pageQuerySchema.Encoded;

/** Applies the shared store limit contract without interpreting a source-specific cursor. */
const parsePageLimit = (query?: PageQuery): number => {
  const parsed = parseWithSchema(pageQuerySchema.from.schema.fields.limit, query?.limit);

  if (!parsed.ok) {
    throw new StoreError(
      'INVALID_LIMIT',
      parsed.error.issues.map((issue) => issue.message).join('; '),
    );
  }

  return parsed.value;
};

type RunPage = typeof runPageSchema.Type;

type CaseSummaryPage = typeof caseSummaryPageSchema.Type;

export {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  pageQuerySchema,
  parsePageLimit,
  runPageSchema,
  caseSummaryPageSchema,
  type PageQuery,
  type RunPage,
  type CaseSummaryPage,
};
