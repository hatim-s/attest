import { z } from 'zod';
import { runRecordSchema, caseRecordSchema, caseSummarySchema } from '@attest/core/records';

const reportSnapshotSchema = z.object({
  generatedAt: z.string(),
  run: runRecordSchema,
  cases: z.array(z.object({ record: caseRecordSchema, summary: caseSummarySchema })),
  truncated: z.boolean(),
});

type ReportSnapshot = z.infer<typeof reportSnapshotSchema>;

export { reportSnapshotSchema, type ReportSnapshot };
