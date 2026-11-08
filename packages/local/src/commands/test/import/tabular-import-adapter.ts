import { withCommandCleanup } from '../../shared/command-cleanup.js';
import * as Effect from 'effect/Effect';
import { createReadStream } from 'node:fs';
import { extname, resolve } from 'node:path';

import type { CaseImportOptions, ImportFormat, TestCase } from '@attest/contracts';
import {
  DEFAULT_IMPORT_LIMITS,
  discoverCsvHeaders,
  importTabularCases,
  TabularImportError,
} from '@attest/core';

import { LocalError } from '../../../errors/index.js';

type ImportCommandAdapterOptions = {
  collisionContexts?: Parameters<typeof importTabularCases>[0]['collisionContexts'];
  existingCases?: readonly TestCase[];
  importOptions: CaseImportOptions;
  preparedSource?: Uint8Array;
  readImportStdin: () => AsyncIterable<string | Uint8Array>;
  source: string;
  workingDirectory: string;
};

/**
 * Collects an import stream and stops reading as soon as it passes the byte limit, so an
 * oversized file or stdin pipe is never fully buffered.
 */
const collectBoundedImportSource = Effect.fn('collectBoundedImportSource')(function* (
  chunks: AsyncIterable<string | Uint8Array>,
  maxBytes = DEFAULT_IMPORT_LIMITS.maxBytes,
) {
  const collected: Uint8Array[] = [];
  let byteLength = 0;

  const iterator = chunks[Symbol.asyncIterator]();

  return yield* withCommandCleanup(
    Effect.gen(function* () {
      for (;;) {
        const next = yield* Effect.tryPromise({
          try: () => iterator.next(),
          catch: (cause) =>
            new LocalError('cli_usage', 'Could not read the requested import source.', {
              path: '<source>',
              cause,
            }),
        });

        if (next.done) break;
        const chunk = next.value;
        const bytes = chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(chunk);
        byteLength += bytes.byteLength;

        if (byteLength > maxBytes) {
          return yield* new TabularImportError('Import source validation failed.', [
            {
              code: 'import_size_limit',
              destination_path: '',
              hint: 'Split the source into smaller explicit imports.',
              message: `Import source exceeds the ${maxBytes}-byte limit.`,
              source_field: '<record>',
            },
          ]);
        }

        collected.push(bytes);
      }

      const source = new Uint8Array(byteLength);
      let offset = 0;

      for (const chunk of collected) {
        source.set(chunk, offset);
        offset += chunk.byteLength;
      }

      return source;
    }),
    [
      Effect.tryPromise({
        try: () => Promise.resolve(iterator.return?.()),
        catch: (cause) =>
          new LocalError('cli_usage', 'Could not read the requested import source.', {
            path: '<source>',
            cause,
          }),
      }).pipe(
        Effect.interruptible,
        Effect.timeoutOption('1 second'),
        Effect.flatMap((result) =>
          result._tag === 'None'
            ? Effect.fail(
                new LocalError('cli_usage', 'Import reader cleanup timed out.', {
                  path: '<source>',
                }),
              )
            : Effect.void,
        ),
      ),
    ],
  );
});

const inferImportFormat = Effect.fn('inferImportFormat')(function* (
  source: string,
  explicit?: ImportFormat,
) {
  if (explicit !== undefined) return explicit;

  if (source === '-') {
    return yield* new LocalError('cli_missing_input', 'Stdin imports require an explicit format.', {
      path: '--format',
      hint: 'Pass --format csv|json|jsonl.',
    });
  }

  const extension = extname(source).toLowerCase();

  if (extension === '.csv') return 'csv';

  if (extension === '.json') return 'json';

  if (extension === '.jsonl') return 'jsonl';

  return yield* new LocalError('cli_usage', 'Could not infer the case import format.', {
    path: '--format',
    hint: 'Use a .csv/.json/.jsonl source or pass --format csv|json|jsonl.',
  });
});

/** Reads import bytes without retaining or reporting an absolute private source path. */
const readImportSource = Effect.fn('readImportSource')(function* (
  source: string,
  workingDirectory: string,
  readImportStdin: () => AsyncIterable<string | Uint8Array>,
) {
  const chunks =
    source === '-' ? readImportStdin() : createReadStream(resolve(workingDirectory, source));

  return yield* collectBoundedImportSource(chunks).pipe(
    Effect.mapError((cause) =>
      cause instanceof TabularImportError
        ? cause
        : new LocalError('cli_usage', 'Could not read the requested import source.', {
            path: '<source>',
            hint: 'Pass a readable UTF-8 CSV, JSON, or JSONL file, or `-` for stdin.',
            cause,
          }),
    ),
  );
});

type PreparedImportSource = { csvHeaders: string[]; format: ImportFormat; source: Uint8Array };

/** Converts aggregate engine diagnostics into parity-safe human and structured CLI details. */
const toCliImportError = (error: TabularImportError): LocalError => {
  const humanDiagnostics = error.diagnostics
    .map((entry) => {
      const location = entry.line === undefined ? `row ${entry.row ?? '?'}` : `line ${entry.line}`;

      return `${location}, source ${entry.source_field}, destination ${entry.destination_path || '<record>'}: ${entry.code}: ${entry.message} ${entry.hint}`;
    })
    .join('\n');

  return new LocalError('project_invalid', error.message, {
    path: '<source>',
    hint: `Repair every listed diagnostic, then retry the all-or-nothing import.\n${humanDiagnostics}`,
    details: { diagnostics: error.diagnostics.map((entry) => ({ ...entry })) },
    cause: error,
  });
};

/** Runs one pure import operation while preserving unexpected exceptions as defects. */
const tabularImportCall = <A>(operation: () => A) =>
  Effect.try({ try: operation, catch: (cause) => cause }).pipe(
    Effect.catch((cause) =>
      cause instanceof TabularImportError
        ? Effect.fail(toCliImportError(cause))
        : Effect.die(cause),
    ),
  );

/** Reads one bounded source once so a guided preview and its confirmed write use identical bytes. */
const prepareImportSource = Effect.fn('prepareImportSource')(function* (
  source: string,
  workingDirectory: string,
  readImportStdin: () => AsyncIterable<string | Uint8Array>,
  explicitFormat?: ImportFormat,
) {
  const format = yield* inferImportFormat(source, explicitFormat);

  const boundedSource = yield* readImportSource(source, workingDirectory, readImportStdin).pipe(
    Effect.mapError((error) =>
      error instanceof TabularImportError ? toCliImportError(error) : error,
    ),
  );

  const csvHeaders =
    format === 'csv' ? yield* tabularImportCall(() => discoverCsvHeaders(boundedSource)) : [];

  return {
    csvHeaders,
    format,
    source: boundedSource,
  } satisfies PreparedImportSource;
});

/** Adapts a CLI request to the reusable all-in-memory import engine. */
const runTabularImportAdapter = Effect.fn('runTabularImportAdapter')(function* (
  options: ImportCommandAdapterOptions,
) {
  const format = yield* inferImportFormat(options.source, options.importOptions.format);

  const source =
    options.preparedSource ??
    (yield* readImportSource(
      options.source,
      options.workingDirectory,
      options.readImportStdin,
    ).pipe(
      Effect.mapError((error) =>
        error instanceof TabularImportError ? toCliImportError(error) : error,
      ),
    ));

  return yield* tabularImportCall(() =>
    importTabularCases({
      collisionContexts: options.collisionContexts,
      dedupe: options.importOptions.dedupe,
      existingCases: options.existingCases,
      format,
      keySource: options.importOptions.key,
      mappings: options.importOptions.mapping,
      onConflict: options.importOptions.on_conflict,
      parseJsonSources: options.importOptions.parse_json,
      recordsPointer: options.importOptions.records_pointer,
      source,
      sync: options.importOptions.sync,
    }),
  );
});

export {
  collectBoundedImportSource,
  inferImportFormat,
  prepareImportSource,
  runTabularImportAdapter,
  type ImportCommandAdapterOptions,
  type PreparedImportSource,
};
