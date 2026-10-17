import { z } from 'zod';
import {
  runPageSchema,
  runRecordSchema,
  caseSummaryPageSchema,
  caseRecordSchema,
  runDiffSchema,
} from '@attest/core/records';
import type { ApiRoute } from './routes.js';

const apiResponses = {
  listRuns: runPageSchema,
  getRun: runRecordSchema,
  listCaseSummaries: caseSummaryPageSchema,
  getCase: caseRecordSchema,
  getDiff: runDiffSchema,
} as const satisfies Record<ApiRoute, z.ZodType>;

export { apiResponses };
