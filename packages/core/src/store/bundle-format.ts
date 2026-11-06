import { stripStruct, SchemaDecodeError } from '@attest/contracts';
import { parseWithSchema } from '@attest/contracts';

type CreateContentHasherResult = { add(line: string): void; digest(): string };

type CreateBundleResult = { lines: string[]; manifest: BundleManifest };

import { createHash } from 'node:crypto';
import * as Schema from 'effect/Schema';

import { canonicalStringify } from './internal/canonical-json.js';
import { caseRecordSchema, runRecordSchema } from './internal/record-schema.js';
import { formatRecordIssues } from './internal/record-validation.js';
import { StoreError } from './store-error.js';
import type { CaseRecord, RunRecord } from './types.js';

const BUNDLE_SCHEMA_ID = 'attest.bundle';

const bundleLineSchema = Schema.Union([
  stripStruct({
    type: Schema.Literal('bundle_header'),
    schema: Schema.Unknown.check(
      Schema.makeFilter(
        (value) =>
          value === BUNDLE_SCHEMA_ID ||
          `Run bundle header uses unsupported schema ${JSON.stringify(value)}; expected ${JSON.stringify(BUNDLE_SCHEMA_ID)}.`,
      ),
    ).pipe(Schema.decodeTo(Schema.Literal(BUNDLE_SCHEMA_ID))),
    run: runRecordSchema,
  }),
  stripStruct({ type: Schema.Literal('case'), case: caseRecordSchema }),
  stripStruct({
    type: Schema.Literal('bundle_footer'),
    case_count: Schema.Finite.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
    content_hash: Schema.String,
  }),
]);

/** One verified NDJSON record of a run bundle: the header, a case, or the footer. */
type BundleLine = typeof bundleLineSchema.Type;

/** Summarizes a completed export with its record count and content hash. */
interface BundleManifest {
  schemaId: typeof BUNDLE_SCHEMA_ID;
  runId: string;
  caseCount: number;
  contentHash: string;
}

/** Incrementally hashes canonical NDJSON lines without including a trailing newline. */
const createContentHasher = (): CreateContentHasherResult => {
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
const createBundle = (run: RunRecord, cases: CaseRecord[]): CreateBundleResult => {
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

const corruptBundle = (message: string, cause?: unknown): StoreError =>
  new StoreError('CORRUPT_DATA', message, cause === undefined ? undefined : { cause });

/** Names the failed record so an operator can tell a foreign schema from a damaged run or case. */
const lineFailure = (error: SchemaDecodeError, lineNumber: number): string => {
  const [issue] = error.issues;

  switch (issue?.path[0]) {
    case 'schema':
      return issue.message;
    case 'run':
      return `Run bundle header contains a malformed run: ${formatRecordIssues(error.issues, 'header').join('; ')}`;
    case 'case':
      return `Run bundle case line ${lineNumber} is malformed.`;
    case 'case_count':
    case 'content_hash':
      return 'Run bundle footer is malformed.';
    default:
      return `Run bundle line ${lineNumber} has no known record type.`;
  }
};

/** Parses one NDJSON record, converting its zero-based index to a line number in errors. */
const parseBundleLine = (line: string, index: number): BundleLine => {
  let json: unknown;

  try {
    json = JSON.parse(line);
  } catch (error) {
    throw corruptBundle(`Run bundle line ${index + 1} contains invalid JSON.`, error);
  }

  const parsed = parseWithSchema(bundleLineSchema, json);

  if (!parsed.ok) throw corruptBundle(lineFailure(parsed.error, index + 1), parsed.error);

  return parsed.value;
};

/**
 * Checks bundle structure, unique case identities, case count, and content hash, so an
 * importer never persists part of a truncated or tampered bundle. Throws `CORRUPT_DATA` otherwise.
 */
const verifyBundleLines = (lines: string[]) => {
  if (lines.length === 0) throw corruptBundle('Run bundle is empty.');
  const records = lines.map(parseBundleLine);
  const [header, ...body] = records;

  if (header?.type !== 'bundle_header') {
    throw corruptBundle('Run bundle must start with a bundle_header record.');
  }

  const footer = body.pop();

  if (footer?.type !== 'bundle_footer') throw corruptBundle('Run bundle is missing its footer.');

  const cases: CaseRecord[] = [];
  const identities = new Set<string>();
  const rowIds = new Set<string>();

  for (const [index, record] of body.entries()) {
    if (record.type === 'bundle_footer') {
      throw corruptBundle('Run bundle footer must appear exactly once and be final.');
    }

    if (record.type === 'bundle_header') {
      throw corruptBundle('Run bundle must contain exactly one header in the first position.');
    }

    if (record.case.runId !== header.run.id) {
      throw corruptBundle(`Run bundle case line ${index + 2} is malformed.`);
    }

    const identity = JSON.stringify([record.case.suiteName, record.case.caseId]);

    if (identities.has(identity)) {
      throw corruptBundle(`Run bundle contains duplicate case ${identity}.`);
    }

    if (rowIds.has(record.case.rowId)) {
      throw corruptBundle(
        `Run bundle contains duplicate rowId ${JSON.stringify(record.case.rowId)}.`,
      );
    }

    identities.add(identity);
    rowIds.add(record.case.rowId);
    cases.push(record.case);
  }

  if (footer.case_count !== body.length) {
    throw corruptBundle('Run bundle footer case count does not match its case records.');
  }

  const hasher = createContentHasher();

  for (const line of lines.slice(0, -1)) hasher.add(line);

  if (footer.content_hash !== hasher.digest()) {
    throw corruptBundle('Run bundle footer content hash does not match its contents.');
  }

  return { run: header.run, cases, footer };
};

export {
  BUNDLE_SCHEMA_ID,
  createBundle,
  createContentHasher,
  type BundleLine,
  type BundleManifest,
  parseBundleLine,
  verifyBundleLines,
};
