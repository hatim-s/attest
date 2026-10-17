import { z } from 'zod';

import { runRecordSchema } from '../store/internal/record-schema.js';
import { caseSummarySchema } from './projection-schemas.js';

const DEFAULT_PAGE_LIMIT = 100;

const MAX_PAGE_LIMIT = 1_000;

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
type PageQuery = { cursor?: string; limit?: number };

type RunPage = z.infer<typeof runPageSchema>;

type CaseSummaryPage = z.infer<typeof caseSummaryPageSchema>;

export {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  runPageSchema,
  caseSummaryPageSchema,
  type PageQuery,
  type RunPage,
  type CaseSummaryPage,
};
