import { z } from 'zod';

import { relativePathSchema, resourceIdSchema, sha256Schema } from '../shared.js';
import { CASE_SCHEMA_ID, DATASET_SCHEMA_ID } from '../../schema/identifiers.js';

const datasetImportDestinationSchema = z
  .string()
  .regex(
    /^(?:id|input(?:\.(?:[A-Za-z0-9_-]|\\[.\\])+)*|expected(?:\.(?:[A-Za-z0-9_-]|\\[.\\])+)*|params(?:\.(?:[A-Za-z0-9_-]|\\[.\\])+)+|tags|metrics)$/u,
    'must target id, input, expected, params, tags, or metrics',
  );

/** Records one source-to-case mapping used by a deterministic dataset import. */
const datasetImportMappingSchema = z.strictObject({
  destination: datasetImportDestinationSchema,
  source: z.string().min(1),
});

/** Records reproducibility metadata without persisting source contents or absolute paths. */
const datasetImportProvenanceSchema = z.strictObject({
  source_type: z.enum(['csv', 'json', 'jsonl']),
  mapping: z.array(datasetImportMappingSchema),
  key_field: z.string().min(1).optional(),
  imported_at: z.iso.datetime({ offset: true }),
  source_content_hash: sha256Schema,
  project_relative_source_path: relativePathSchema.optional(),
  counts: z.strictObject({
    read: z.number().int().nonnegative(),
    inserted: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
});

/** Encodes metadata for one canonical, ordered current dataset JSONL file. */
const datasetResourceSchema = z
  .strictObject({
    schema: z.literal(DATASET_SCHEMA_ID),
    case_schema: z.literal(CASE_SCHEMA_ID),
    id: resourceIdSchema,
    name: z.string().min(1),
    case_count: z.number().int().nonnegative(),
    provenance: datasetImportProvenanceSchema.optional(),
  })
  .meta({ id: 'DatasetResource' });

type DatasetImportMapping = z.infer<typeof datasetImportMappingSchema>;
type DatasetImportProvenance = z.infer<typeof datasetImportProvenanceSchema>;
type DatasetResource = z.infer<typeof datasetResourceSchema>;

export {
  datasetImportDestinationSchema,
  datasetImportMappingSchema,
  datasetImportProvenanceSchema,
  datasetResourceSchema,
  type DatasetImportMapping,
  type DatasetImportProvenance,
  type DatasetResource,
};
