import * as Effect from 'effect/Effect';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  BUNDLE_SCHEMA_ID,
  createBundle,
  StoreError,
  verifyBundleLines,
  type BundleLine,
  type RunStore,
} from '@attest/core';
import { storeCall, storeDecode } from './internal/store-effect.js';
import { withReadCleanup } from './internal/read-cleanup.js';

/** Exports canonical bytes after reading the aggregate from the caller's store owner. */
const exportRunBundle = Effect.fn('exportRunBundle')(function* (
  store: RunStore,
  runId: string,
  destination: Writable | string,
) {
  const aggregate = yield* store.getRunWithCases(runId);
  const bundle = createBundle(aggregate.run, aggregate.cases);

  if (!(destination instanceof Writable)) {
    const temporaryPath = `${destination}.${randomUUID()}.tmp`;
    yield* withReadCleanup(
      Effect.gen(function* () {
        yield* storeCall('WRITE_FAILED', 'Could not write bundle.', () =>
          writeFile(temporaryPath, `${bundle.lines.join('\n')}\n`, 'utf8'),
        );
        yield* storeCall('WRITE_FAILED', 'Could not publish bundle.', () =>
          rename(temporaryPath, destination),
        );
      }),
      () => [
        storeCall('WRITE_FAILED', 'Could not remove temporary bundle.', () =>
          rm(temporaryPath, { force: true }),
        ),
      ],
    );
  } else {
    yield* storeCall('WRITE_FAILED', 'Could not write bundle stream.', () =>
      pipeline(Readable.from(bundle.lines.map((line) => `${line}\n`)), destination),
    );
  }

  return bundle.manifest;
});

/** Verifies all lines before exposing records. The caller owns a supplied stream. */
const readRunBundle = Effect.fn('readRunBundle')(function* (source: Readable | string) {
  const owned = !(source instanceof Readable);
  const input = owned ? createReadStream(source, 'utf8') : source;
  const reader = createInterface({ input, crlfDelay: Infinity });
  const iterator = reader[Symbol.asyncIterator]();

  return yield* withReadCleanup(
    Effect.gen(function* () {
      const lines: string[] = [];

      while (true) {
        const next = yield* Effect.tryPromise({
          try: () => iterator.next(),
          catch: (cause) => new StoreError('CORRUPT_DATA', 'Could not read run bundle.', { cause }),
        });

        if (next.done) break;
        lines.push(next.value);
      }

      const { run, cases, footer } = yield* storeDecode('Invalid run bundle.', () =>
        verifyBundleLines(lines),
      );

      const records: BundleLine[] = [
        { type: 'bundle_header', schema: BUNDLE_SCHEMA_ID, run },
        ...cases.map((record): BundleLine => ({ type: 'case', case: record })),
        footer,
      ];

      return records;
    }),
    () => [
      Effect.sync(() => {
        reader.close();

        if (owned) input.destroy();
      }),
    ],
  );
});

export { exportRunBundle, readRunBundle };
