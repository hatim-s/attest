import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadDatasetCases } from './dataset.js';

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-dataset-test-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('loadDatasetCases', () => {
  it('loads valid JSONL cases relative to the base directory', async () => {
    const directory = await createTemporaryDirectory();
    await writeFile(
      join(directory, 'cases.jsonl'),
      [
        JSON.stringify({ id: 'one', input: { question: 'first' } }),
        JSON.stringify({
          id: 'two',
          input: null,
          expected: 'answer',
          params: { locale: 'en' },
          metrics: ['quality'],
        }),
      ].join('\n'),
    );

    const result = await loadDatasetCases('./cases.jsonl', directory);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value[1]?.metrics).toEqual(['quality']);
    }
  });

  it('aggregates JSON and structural errors with physical line numbers', async () => {
    const directory = await createTemporaryDirectory();
    await writeFile(
      join(directory, 'invalid.jsonl'),
      ['{"id":"valid","input":{}}', '', '{bad json', '{"id":3,"extra":true}'].join('\n'),
    );

    const result = await loadDatasetCases('invalid.jsonl', directory);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.map(({ path }) => path)).toEqual([
        'line 3',
        'line 4',
        'line 4',
        'line 4',
      ]);
      expect(result.error.map(({ message }) => message).join(' ')).toContain('input is required');
      expect(result.error.map(({ message }) => message).join(' ')).toContain('unknown case field');
    }
  });

  it('aggregates duplicate case IDs with malformed lines', async () => {
    const directory = await createTemporaryDirectory();
    await writeFile(
      join(directory, 'duplicate.jsonl'),
      [
        JSON.stringify({ id: 'repeated', input: {} }),
        '{bad json',
        JSON.stringify({ id: 'repeated', input: {} }),
      ].join('\n'),
    );

    const result = await loadDatasetCases('duplicate.jsonl', directory);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'line 2' }),
          { path: 'line 3', message: 'duplicate case id "repeated"' },
        ]),
      );
      expect(result.error).toHaveLength(2);
    }
  });

  it('returns a contract issue when the dataset file is missing', async () => {
    const directory = await createTemporaryDirectory();
    const result = await loadDatasetCases('missing.jsonl', directory);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toHaveLength(1);
      expect(result.error[0]?.path).toBe(join(directory, 'missing.jsonl'));
    }
  });
});
