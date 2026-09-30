import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { finished } from 'node:stream/promises';
import type { Readable, Writable } from 'node:stream';

import {
  createBundle,
  StoreError,
  verifyBundleLines,
  type BundleLine,
  type BundleManifest,
  type RunStore,
} from '@attest/core';

const corruptBundle = (message: string, cause?: unknown): StoreError =>
  new StoreError('CORRUPT_DATA', message, cause === undefined ? undefined : { cause });

/** Writes a line to a generic destination and waits for backpressure to clear. */
const writeToStream = async (destination: Writable, line: string): Promise<void> => {
  if (!destination.write(`${line}\n`)) {
    await new Promise<void>((resolve, reject) => {
      destination.once('drain', resolve);
      destination.once('error', reject);
    });
  }
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
    for (const line of bundle.lines) await writeToStream(destination, line);
    destination.end();
    await finished(destination);
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

export { exportRunBundle, readRunBundle };
