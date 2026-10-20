import { z } from 'zod';

import { StoreError } from '../store/store-error.js';
import { runRecordSchema } from '../store/internal/record-schema.js';
import { caseSummarySchema } from './projection-schemas.js';

const DEFAULT_PAGE_LIMIT = 100;

const MAX_PAGE_LIMIT = 1_000;

/** Keeps typed store reads and coerced HTTP queries on the same page bounds. */
const isValidPageLimit = (limit: number): boolean =>
  Number.isInteger(limit) && limit >= 1 && limit <= MAX_PAGE_LIMIT;

const pageQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z
    .number()
    .refine(isValidPageLimit, {
      message: `Page limit must be an integer from 1 to ${MAX_PAGE_LIMIT}.`,
    })
    .default(DEFAULT_PAGE_LIMIT),
});

const cursorSchema = z.string().min(1);

const runPageSchema = z.object({
  items: z.array(runRecordSchema),
  nextCursor: cursorSchema.optional(),
});

const caseSummaryPageSchema = z.object({
  items: z.array(caseSummarySchema),
  nextCursor: cursorSchema.optional(),
});

/** Cursors are opaque to callers; each source decides what one encodes. */
type PageQuery = z.input<typeof pageQuerySchema>;

/** Applies the shared store limit contract without interpreting a source-specific cursor. */
const parsePageLimit = (query?: PageQuery): number => {
  const parsed = pageQuerySchema.shape.limit.safeParse(query?.limit);

  if (!parsed.success) {
    throw new StoreError(
      'INVALID_LIMIT',
      parsed.error.issues.map((issue) => issue.message).join('; '),
    );
  }

  return parsed.data;
};

type RunPage = z.infer<typeof runPageSchema>;

type CaseSummaryPage = z.infer<typeof caseSummaryPageSchema>;

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
