import * as Effect from 'effect/Effect';
import {
  parseWithSchema,
  datasetResourceSchema,
  testCaseSchema,
  type ProjectManifest,
  type TestCase,
  type JsonValue,
} from '@attest/contracts';

import { hashCanonicalJsonLines } from '@attest/core';
import {
  loadJsonResource,
  parseJson,
  readProjectSource,
  schemaDiagnostics,
} from './source-loader.js';
import type { LoadedDatasetResource } from './types.js';

/** Loads an ordered JSONL dataset and preserves physical line context for every row failure. */
const loadDataset = Effect.fn('loadDataset')(function* (
  root: string,
  entry: ProjectManifest['resources']['datasets'][number],
): Effect.fn.Return<
  LoadedDatasetResource,
  | import('../../internal/open-anchored.js').AnchoredCleanupFailure
  | import('../../internal/open-anchored.js').AnchoredFileFailure
> {
  const metadata = yield* loadJsonResource(
    root,
    entry.metadata_path,
    entry.metadata_content_hash,
    datasetResourceSchema,
  );

  const loadedData = yield* readProjectSource(root, entry.data_path);
  const diagnostics = [...metadata.diagnostics, ...loadedData.diagnostics];
  const cases: TestCase[] = [];
  const canonicalRecords: JsonValue[] = [];

  if (loadedData.text === undefined) {
    return {
      diagnostics,
      metadataHash: metadata.hash,
      source: { data: entry.data_path, metadata: entry.metadata_path },
    };
  }

  loadedData.text.split(/\r?\n/u).forEach((line, index) => {
    if (line.trim().length === 0) return;
    const lineNumber = index + 1;
    const parsed = parseJson(line, entry.data_path, `line ${lineNumber}`);
    diagnostics.push(...parsed.diagnostics);

    if (parsed.value === undefined) return;
    canonicalRecords.push(parsed.value);
    const validated = parseWithSchema(testCaseSchema, parsed.value);

    if (!validated.ok) {
      diagnostics.push(
        ...schemaDiagnostics(entry.data_path, validated.error.issues, [`line ${lineNumber}`]),
      );

      return;
    }

    cases.push(validated.value);
  });

  const dataHash = hashCanonicalJsonLines(canonicalRecords);

  if (dataHash !== entry.data_content_hash) {
    diagnostics.push({
      code: 'content_hash_mismatch',
      message: `canonical SHA-256 is ${dataHash}, manifest records ${entry.data_content_hash}`,
      source: entry.data_path,
    });
  }

  return {
    dataHash,
    diagnostics,
    metadataHash: metadata.hash,
    source: { data: entry.data_path, metadata: entry.metadata_path },
    value:
      metadata.value === undefined || cases.length !== canonicalRecords.length
        ? undefined
        : { cases, metadata: metadata.value },
  };
});

export { loadDataset };
