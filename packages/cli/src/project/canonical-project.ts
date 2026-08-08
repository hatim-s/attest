import { createHash } from 'node:crypto';

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** Recursively orders JSON object keys while preserving semantically ordered arrays. */
const canonicalizeJson = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      // JavaScript code-unit ordering is locale-independent across supported hosts.
      .sort(([left], [right]) => (left > right ? 1 : 0) - (left < right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalizeJson(entry)]),
  );
};

/** Serializes one JSON value without formatting-dependent bytes. */
const serializeCanonicalJson = (value: JsonValue): string =>
  JSON.stringify(canonicalizeJson(value));

/** Serializes ordered JSONL records with one canonical newline separator and no trailing newline. */
const serializeCanonicalJsonLines = (values: readonly JsonValue[]): string =>
  values.map(serializeCanonicalJson).join('\n');

/** Computes the lowercase SHA-256 content hash used by v2 project manifests. */
const hashCanonicalContent = (canonicalContent: string): string =>
  createHash('sha256').update(canonicalContent, 'utf8').digest('hex');

/** Computes a formatting-independent hash for one parsed JSON document. */
const hashCanonicalJson = (value: JsonValue): string =>
  hashCanonicalContent(serializeCanonicalJson(value));

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

/** Computes a formatting-independent hash for ordered parsed JSONL records. */
const hashCanonicalJsonLines = (values: readonly JsonValue[]): string =>
  hashCanonicalContent(serializeCanonicalJsonLines(values));

export {
  datasetMetadataForHash,
  hashCanonicalContent,
  hashDatasetMetadata,
  hashCanonicalJson,
  hashCanonicalJsonLines,
  serializeCanonicalJson,
  serializeCanonicalJsonLines,
  type JsonValue,
};
