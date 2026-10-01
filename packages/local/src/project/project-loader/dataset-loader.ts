import {
  datasetResourceSchema,
  testCaseSchema,
  type ProjectManifest,
  type TestCase,
} from '@attest/contracts';

import { hashCanonicalJsonLines, type JsonValue } from '../canonical-project.js';
import {
  loadJsonResource,
  parseJson,
  readProjectSource,
  schemaDiagnostics,
} from './source-loader.js';
import type { LoadedDatasetResource } from './types.js';

/** Loads an ordered JSONL dataset and preserves physical line context for every row failure. */
const loadDataset = async (
  root: string,
  entry: ProjectManifest['resources']['datasets'][number],
): Promise<LoadedDatasetResource> => {
  const metadata = await loadJsonResource(
    root,
    entry.metadata_path,
    entry.metadata_content_hash,
    datasetResourceSchema,
  );
  const loadedData = await readProjectSource(root, entry.data_path);
  const diagnostics = [...metadata.diagnostics, ...loadedData.diagnostics];
  const cases: TestCase[] = [];
  const caseLines: number[] = [];
  const canonicalRecords: JsonValue[] = [];

  if (loadedData.text === undefined) {
    return {
      caseLines,
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
    const validated = testCaseSchema.safeParse(parsed.value);
    if (!validated.success) {
      diagnostics.push(
        ...schemaDiagnostics(entry.data_path, validated.error.issues, [`line ${lineNumber}`]),
      );
      return;
    }
    cases.push(validated.data);
    caseLines.push(lineNumber);
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
    caseLines,
    dataHash,
    diagnostics,
    metadataHash: metadata.hash,
    source: { data: entry.data_path, metadata: entry.metadata_path },
    value:
      metadata.value === undefined || cases.length !== canonicalRecords.length
        ? undefined
        : { cases, metadata: metadata.value },
  };
};

export { loadDataset };
