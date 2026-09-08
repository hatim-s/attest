import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  BUNDLE_SCHEMA_ID,
  createBundle,
  createContentHasher,
  type BundleCase,
  type BundleFooter,
  type BundleHeader,
  type BundleLine,
  type BundleManifest,
} from './bundle-format.js';
import { collectRunRecordViolations, isCaseRecord } from './internal/record-validation.js';
import { StoreError, type RunStore } from './types.js';

type JsonObject = Record<string, unknown>;

const corruptBundle = (message: string, cause?: unknown): StoreError =>
  new StoreError('CORRUPT_DATA', message, cause === undefined ? undefined : { cause });

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const parseJsonLine = (line: string, index: number): JsonObject => {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isObject(parsed) || typeof parsed.type !== 'string') {
      throw corruptBundle(`Run bundle line ${index + 1} is missing a string type.`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw corruptBundle(`Run bundle line ${index + 1} contains invalid JSON.`, error);
  }
};

/** Verifies all integrity and structural checks before returning any caller-visible records. */
const verifyBundleLines = (lines: string[]): BundleLine[] => {
  if (lines.length === 0) throw corruptBundle('Run bundle is empty.');
  const parsedLines = lines.map(parseJsonLine);
  const first = parsedLines[0];
  if (first?.type !== 'bundle_header') {
    throw corruptBundle('Run bundle must start with a bundle_header record.');
  }
  if (first.schema !== BUNDLE_SCHEMA_ID) {
    throw corruptBundle(
      `Run bundle header uses unsupported schema ${JSON.stringify(first.schema)}; expected ${JSON.stringify(BUNDLE_SCHEMA_ID)}.`,
    );
  }
  const runViolations = collectRunRecordViolations(first.run, 'header.run');
  if (runViolations.length > 0) {
    throw corruptBundle(`Run bundle header contains a malformed run: ${runViolations.join('; ')}`);
  }

  const header = first as unknown as BundleHeader;
  const recognized: BundleLine[] = [header];
  const headerRunId = header.run.id;
  const hasher = createContentHasher();
  let caseCount = 0;
  let headerCount = 0;
  let footer: BundleFooter | undefined;
  for (const [index, parsed] of parsedLines.entries()) {
    if (parsed.type === 'bundle_footer') {
      if (index !== parsedLines.length - 1 || footer) {
        throw corruptBundle('Run bundle footer must appear exactly once and be final.');
      }
      if (!Number.isInteger(parsed.case_count) || typeof parsed.content_hash !== 'string') {
        throw corruptBundle('Run bundle footer is malformed.');
      }
      footer = parsed as unknown as BundleFooter;
      continue;
    }

    hasher.add(lines[index] ?? '');
    if (parsed.type === 'bundle_header') {
      headerCount += 1;
      if (index !== 0 || headerCount !== 1) {
        throw corruptBundle('Run bundle must contain exactly one header in the first position.');
      }
      continue;
    }
    if (parsed.type === 'case') {
      if (!isCaseRecord(parsed.case) || parsed.case.runId !== headerRunId) {
        throw corruptBundle(`Run bundle case line ${index + 1} is malformed.`);
      }
      caseCount += 1;
      recognized.push(parsed as unknown as BundleCase);
      continue;
    }
    throw corruptBundle(
      `Run bundle line ${index + 1} has an unknown record type for schema ${JSON.stringify(first.schema)}.`,
    );
  }

  if (!footer) throw corruptBundle('Run bundle is missing its footer.');
  if (footer.case_count !== caseCount) {
    throw corruptBundle('Run bundle footer case count does not match its case records.');
  }
  if (footer.content_hash !== hasher.digest()) {
    throw corruptBundle('Run bundle footer content hash does not match its contents.');
  }
  recognized.push(footer);
  return recognized;
};

/** Atomically replaces a file only after its complete PLAN 1S.4 bundle is available. */
const writeAtomically = async (destination: string, contents: string): Promise<void> => {
  const temporaryPath = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, 'utf8');
    await rename(temporaryPath, destination);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new StoreError('WRITE_FAILED', `Could not write run bundle to ${destination}.`, {
      cause: error,
    });
  }
};

/** Exports a canonical PLAN 1S.4 bundle to an atomic file or caller-owned stream. */
const exportRunBundle = async (
  store: RunStore,
  runId: string,
  destination: Writable | string,
): Promise<BundleManifest> => {
  const aggregate = await store.getRunWithCases(runId);
  const bundle = createBundle(aggregate.run, aggregate.cases);
  if (typeof destination === 'string') {
    await writeAtomically(destination, `${bundle.lines.join('\n')}\n`);
    return bundle.manifest;
  }
  try {
    await pipeline(Readable.from(bundle.lines.map((line) => `${line}\n`)), destination);
    return bundle.manifest;
  } catch (error) {
    throw new StoreError('WRITE_FAILED', 'Could not write run bundle to the destination stream.', {
      cause: error,
    });
  }
};

/** Spools and verifies a single-run bundle before exposing any records. */
async function* readRunBundle(source: Readable | string): AsyncIterable<BundleLine> {
  const input = typeof source === 'string' ? createReadStream(source, 'utf8') : source;
  const lines: string[] = [];
  try {
    // Integrity precedes exposure; bundles are single-run sized, while cloud-scale streaming is future work.
    for await (const line of createInterface({ input, crlfDelay: Infinity })) lines.push(line);
    const verified = verifyBundleLines(lines);
    for (const line of verified) yield line;
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw corruptBundle('Could not read run bundle.', error);
  }
}

export { exportRunBundle, readRunBundle, verifyBundleLines };
