import { stripStruct } from '@attest/contracts';
import * as Schema from 'effect/Schema';
import {
  runRecordSchema,
  caseRecordSchema,
  caseSummarySchema,
  projectRecordSchema,
} from '@attest/core/records';

const reportSnapshotSchema = stripStruct({
  generatedAt: Schema.String,
  project: projectRecordSchema,
  run: runRecordSchema,
  cases: Schema.Array(stripStruct({ record: caseRecordSchema, summary: caseSummarySchema })),
  truncated: Schema.Boolean,
});

type ReportSnapshot = typeof reportSnapshotSchema.Type;

export { reportSnapshotSchema, type ReportSnapshot };
