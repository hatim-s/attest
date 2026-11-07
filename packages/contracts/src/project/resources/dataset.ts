import { nonnegativeIntegerSchema, timestampSchema } from '../../schema/scalars.js';
import * as Schema from 'effect/Schema';

import { relativePathSchema, resourceIdSchema, sha256Schema } from '../shared.js';
import { CASE_SCHEMA_ID, DATASET_SCHEMA_ID } from '../../schema/identifiers.js';

const datasetImportDestinationSchema = Schema.String.check(
  Schema.isPattern(
    /^(?:id|input(?:\.(?:[A-Za-z0-9_-]|\\[.\\])+)*|expected(?:\.(?:[A-Za-z0-9_-]|\\[.\\])+)*|params(?:\.(?:[A-Za-z0-9_-]|\\[.\\])+)+|tags|folder|metric_overrides)$/u,
    { message: 'must target id, input, expected, params, tags, folder, or metric_overrides' },
  ),
);

/** Records one source-to-case mapping used by a deterministic dataset import. */
const datasetImportMappingSchema = Schema.Struct({
  destination: datasetImportDestinationSchema,
  source: Schema.String.check(Schema.isMinLength(1)),
});

/** Records reproducibility metadata without persisting source contents or absolute paths. */
const datasetImportProvenanceSchema = Schema.Struct({
  source_type: Schema.Literals(['csv', 'json', 'jsonl']),
  mapping: Schema.Array(datasetImportMappingSchema),
  key_field: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  imported_at: timestampSchema,
  source_content_hash: sha256Schema,
  project_relative_source_path: Schema.optional(relativePathSchema),
  counts: Schema.Struct({
    read: nonnegativeIntegerSchema,
    inserted: nonnegativeIntegerSchema,
    updated: nonnegativeIntegerSchema,
    skipped: nonnegativeIntegerSchema,
  }),
});

/** Encodes metadata for one canonical, ordered current dataset JSONL file. */
const datasetResourceSchema = Schema.Struct({
  schema: Schema.Literal(DATASET_SCHEMA_ID),
  case_schema: Schema.Literal(CASE_SCHEMA_ID),
  id: resourceIdSchema,
  name: Schema.String.check(Schema.isMinLength(1)),
  case_count: nonnegativeIntegerSchema,
  provenance: Schema.optional(datasetImportProvenanceSchema),
}).annotate({ identifier: 'DatasetResource' });

type DatasetImportMapping = typeof datasetImportMappingSchema.Type;

type DatasetImportProvenance = typeof datasetImportProvenanceSchema.Type;

type DatasetResource = typeof datasetResourceSchema.Type;

export {
  datasetImportDestinationSchema,
  datasetImportMappingSchema,
  datasetImportProvenanceSchema,
  datasetResourceSchema,
  type DatasetImportMapping,
  type DatasetImportProvenance,
  type DatasetResource,
};
