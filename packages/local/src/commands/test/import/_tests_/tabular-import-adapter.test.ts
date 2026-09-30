import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CaseImportOptions } from '@attest/contracts';
import { describe, expect, it, onTestFinished } from 'vitest';

import { LocalError } from '../../../../errors/index.js';
import { runTabularImportAdapter } from '../tabular-import-adapter.js';

const noStdin = (): AsyncIterable<Uint8Array> => {
  throw new Error('stdin must not be read');
};

/** Runs the adapter and returns the LocalError it must raise. */
const importFailure = async (options: {
  importOptions?: CaseImportOptions;
  readImportStdin?: () => AsyncIterable<string | Uint8Array>;
  source: string;
}): Promise<LocalError> => {
  const error: unknown = await runTabularImportAdapter({
    importOptions: options.importOptions ?? {},
    readImportStdin: options.readImportStdin ?? noStdin,
    source: options.source,
    workingDirectory: tmpdir(),
  }).catch((caught: unknown) => caught);
  if (!(error instanceof LocalError)) throw new Error('Expected a LocalError.');
  return error;
};

const writeSource = async (name: string, contents: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-import-adapter-'));
  onTestFinished(() => rm(directory, { force: true, recursive: true }));
  const path = join(directory, name);
  await writeFile(path, contents);
  return path;
};

describe('runTabularImportAdapter', () => {
  it('reports every JSONL and JSON record error with its physical location', async () => {
    const jsonlSource = await writeSource(
      'cases.jsonl',
      [
        'not-json',
        '',
        '{"input":"ok","extra":true,"slash/key":true,"tilde~key":true}',
        '{"expected":"missing-input"}',
      ].join('\n'),
    );
    const jsonl = await importFailure({ source: jsonlSource });
    expect(jsonl.code).toBe('project_invalid');
    expect(jsonl.details).toMatchObject({
      diagnostics: [
        { line: 1, source_field: '<line>', destination_path: '' },
        { line: 3, source_field: '/extra', destination_path: '/extra' },
        { line: 3, source_field: '/slash~1key', destination_path: '/slash~1key' },
        { line: 3, source_field: '/tilde~0key', destination_path: '/tilde~0key' },
        { line: 4, source_field: '/input', destination_path: '/input' },
      ],
    });

    const jsonSource = await writeSource(
      'cases.json',
      JSON.stringify([{ input: 'ok', extra: true }, { expected: 'missing-input' }]),
    );
    const json = await importFailure({ source: jsonSource });
    expect(json.details).toMatchObject({ diagnostics: [{ row: 1 }, { row: 2 }] });
  });

  it('rejects malformed UTF-8 and oversized stdin without reading past the limit', async () => {
    const invalid = await importFailure({
      importOptions: { format: 'jsonl' },
      readImportStdin: async function* readInvalidStdin() {
        await Promise.resolve();
        yield new Uint8Array([...new TextEncoder().encode('{"input":"'), 255, 34, 125]);
      },
      source: '-',
    });
    expect(invalid.details).toMatchObject({ diagnostics: [{ code: 'invalid_utf8' }] });

    let consumedPastLimit = false;
    const oversized = await importFailure({
      importOptions: { format: 'jsonl' },
      readImportStdin: async function* readOversizedStdin() {
        await Promise.resolve();
        yield new Uint8Array(6 * 1024 * 1024);
        yield new Uint8Array(6 * 1024 * 1024);
        consumedPastLimit = true;
        yield new Uint8Array([1]);
      },
      source: '-',
    });
    expect(oversized.details).toMatchObject({ diagnostics: [{ code: 'import_size_limit' }] });
    expect(consumedPastLimit).toBe(false);
  });
});
