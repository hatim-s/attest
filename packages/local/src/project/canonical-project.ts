import { createHash } from 'node:crypto';

import type { DatasetResource, JsonValue, ProjectManifest } from '@attest/contracts';
import {
  canonicalStringify as serializeCanonicalJson,
  contentHash as hashCanonicalJson,
} from '@attest/core';

/** Serializes ordered JSONL records with one canonical newline separator and no trailing newline. */
const serializeCanonicalJsonLines = (values: readonly JsonValue[]): string =>
  values.map(serializeCanonicalJson).join('\n');

/** Computes the lowercase SHA-256 content hash used by project manifests. */
const hashCanonicalContent = (canonicalContent: string): string =>
  createHash('sha256').update(canonicalContent, 'utf8').digest('hex');

/** Excludes volatile import time from dataset reproducibility hashes while retaining provenance. */
const datasetMetadataForHash = (value: JsonValue): JsonValue => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const provenance = value.provenance;
  if (provenance === null || typeof provenance !== 'object' || Array.isArray(provenance)) {
    return value;
  }

  // imported_at records the real write time; source identity fields remain hash-significant.
  const stableProvenance = Object.fromEntries(
    Object.entries(provenance).filter(([key]) => key !== 'imported_at'),
  );
  return { ...value, provenance: stableProvenance };
};

/** Computes the dataset metadata hash defined by the reproducible authoring contract. */
const hashDatasetMetadata = (value: JsonValue): string =>
  hashCanonicalJson(datasetMetadataForHash(value));

/** Hashes a manifest projection whose dataset metadata hashes exclude only volatile import time. */
const hashProjectManifest = (
  manifest: ProjectManifest,
  datasets: readonly DatasetResource[],
): string => {
  const metadataById = new Map(datasets.map((metadata) => [metadata.id, metadata]));
  const projectedManifest: ProjectManifest = {
    ...manifest,
    resources: {
      ...manifest.resources,
      datasets: manifest.resources.datasets.map((entry) => {
        const metadata = metadataById.get(entry.id);
        if (metadata === undefined) {
          throw new Error(`Missing metadata for dataset ${entry.id}.`);
        }
        return {
          ...entry,
          metadata_content_hash: hashDatasetMetadata(metadata),
        };
      }),
    },
  };
  return hashCanonicalJson(projectedManifest);
};

/** Computes a formatting-independent hash for ordered parsed JSONL records. */
const hashCanonicalJsonLines = (values: readonly JsonValue[]): string =>
  hashCanonicalContent(serializeCanonicalJsonLines(values));

export {
  datasetMetadataForHash,
  hashCanonicalContent,
  hashDatasetMetadata,
  hashCanonicalJson,
  hashCanonicalJsonLines,
  hashProjectManifest,
  serializeCanonicalJson,
  serializeCanonicalJsonLines,
  type JsonValue,
};
