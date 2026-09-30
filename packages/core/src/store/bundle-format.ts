import { createHash } from 'node:crypto';

import { canonicalStringify } from './internal/canonical-json.js';
import { parseCaseRecord, parseRunRecord } from './internal/record-validation.js';
import { StoreError } from './store-error.js';
import type { CaseRecord, RunRecord } from './types.js';

const BUNDLE_SCHEMA_ID = 'attest.bundle';

/** Describes the run metadata at the start of an exported bundle. */
interface BundleHeader {
  type: 'bundle_header';
  schema: typeof BUNDLE_SCHEMA_ID;
  run: RunRecord;
}

/** Describes one case and its embedded metric evidence in a run bundle. */
interface BundleCase {
  type: 'case';
  case: CaseRecord;
}

/** Describes the verified content identity that ends every run bundle. */
interface BundleFooter {
  type: 'bundle_footer';
  case_count: number;
  content_hash: string;
}

type BundleLine = BundleHeader | BundleCase | BundleFooter;

/** Summarizes a completed export with its record count and content hash. */
interface BundleManifest {
  schemaId: typeof BUNDLE_SCHEMA_ID;
  runId: string;
  caseCount: number;
  contentHash: string;
}

/** Incrementally hashes canonical NDJSON lines without including a trailing newline. */
const createContentHasher = (): { add(line: string): void; digest(): string } => {
  const hash = createHash('sha256');
  let hasLine = false;
  return {
    add(line) {
      if (hasLine) hash.update('\n');
      hash.update(line);
      hasLine = true;
    },
    digest: () => hash.digest('hex'),
  };
};

/** Purely assembles canonical bundle lines from one already-loaded run aggregate. */
const createBundle = (
  run: RunRecord,
  cases: CaseRecord[],
): { lines: string[]; manifest: BundleManifest } => {
  const hasher = createContentHasher();
  const headerLine = canonicalStringify({
    type: 'bundle_header',
    schema: BUNDLE_SCHEMA_ID,
    run,
  });
  const lines = [headerLine];
  hasher.add(headerLine);

  for (const caseRecord of cases) {
    const line = canonicalStringify({ type: 'case', case: caseRecord });
    lines.push(line);
    hasher.add(line);
  }

  const contentHash = hasher.digest();
  lines.push(
    canonicalStringify({
      type: 'bundle_footer',
      case_count: cases.length,
      content_hash: contentHash,
    }),
  );
  return {
    lines,
    manifest: {
      schemaId: BUNDLE_SCHEMA_ID,
      runId: run.id,
      caseCount: cases.length,
      contentHash,
    },
  };
};

type JsonObject = Record<string, unknown>;

const corruptBundle = (message: string, cause?: unknown): StoreError =>
  new StoreError('CORRUPT_DATA', message, cause === undefined ? undefined : { cause });

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const parseJsonLine = (line: string, index: number): JsonObject => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw corruptBundle(`Run bundle line ${index + 1} contains invalid JSON.`, error);
  }
  if (!isObject(parsed) || typeof parsed.type !== 'string') {
    throw corruptBundle(`Run bundle line ${index + 1} is missing a string type.`);
  }
  return parsed;
};

const parseHeader = (first: JsonObject | undefined): BundleHeader => {
  if (first?.type !== 'bundle_header') {
    throw corruptBundle('Run bundle must start with a bundle_header record.');
  }
  if (first.schema !== BUNDLE_SCHEMA_ID) {
    throw corruptBundle(
      `Run bundle header uses unsupported schema ${JSON.stringify(first.schema)}; expected ${JSON.stringify(BUNDLE_SCHEMA_ID)}.`,
    );
  }
  const run = parseRunRecord(first.run, 'header.run');
  if (!run.ok) {
    throw corruptBundle(`Run bundle header contains a malformed run: ${run.violations.join('; ')}`);
  }
  return { type: 'bundle_header', schema: BUNDLE_SCHEMA_ID, run: run.value };
};

const parseFooter = (parsed: JsonObject): BundleFooter => {
  if (
    typeof parsed.case_count !== 'number' ||
    !Number.isInteger(parsed.case_count) ||
    typeof parsed.content_hash !== 'string'
  ) {
    throw corruptBundle('Run bundle footer is malformed.');
  }
  return {
    type: 'bundle_footer',
    case_count: parsed.case_count,
    content_hash: parsed.content_hash,
  };
};

/**
 * Checks a bundle's structure, case count, and content hash before any record is exposed, so an
 * importer never persists part of a truncated or tampered bundle. Throws `CORRUPT_DATA` otherwise.
 */
const verifyBundleLines = (lines: string[]): BundleLine[] => {
  if (lines.length === 0) throw corruptBundle('Run bundle is empty.');
  const parsedLines = lines.map(parseJsonLine);
  const header = parseHeader(parsedLines[0]);
  const recognized: BundleLine[] = [header];
  const hasher = createContentHasher();
  hasher.add(lines[0] ?? '');
  let footer: BundleFooter | undefined;
  for (const [index, parsed] of parsedLines.entries()) {
    if (index === 0) continue;
    if (parsed.type === 'bundle_footer') {
      if (index !== parsedLines.length - 1) {
        throw corruptBundle('Run bundle footer must appear exactly once and be final.');
      }
      footer = parseFooter(parsed);
      continue;
    }
    hasher.add(lines[index] ?? '');
    if (parsed.type === 'bundle_header') {
      throw corruptBundle('Run bundle must contain exactly one header in the first position.');
    }
    if (parsed.type !== 'case') {
      throw corruptBundle(
        `Run bundle line ${index + 1} has an unknown record type for schema ${JSON.stringify(header.schema)}.`,
      );
    }
    const caseRecord = parseCaseRecord(parsed.case);
    if (!caseRecord.ok || caseRecord.value.runId !== header.run.id) {
      throw corruptBundle(`Run bundle case line ${index + 1} is malformed.`);
    }
    recognized.push({ type: 'case', case: caseRecord.value });
  }

  if (!footer) throw corruptBundle('Run bundle is missing its footer.');
  if (footer.case_count !== recognized.length - 1) {
    throw corruptBundle('Run bundle footer case count does not match its case records.');
  }
  if (footer.content_hash !== hasher.digest()) {
    throw corruptBundle('Run bundle footer content hash does not match its contents.');
  }
  recognized.push(footer);
  return recognized;
};

export {
  BUNDLE_SCHEMA_ID,
  createBundle,
  createContentHasher,
  type BundleCase,
  type BundleFooter,
  type BundleHeader,
  type BundleLine,
  type BundleManifest,
  verifyBundleLines,
};
