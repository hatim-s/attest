import { readFileSync } from 'node:fs';

import type { DatasetImportMapping, TestCase } from '@attest/contracts';
import { describe, expect, it } from 'vitest';

import { createContentCaseId, createKeyedCaseId } from './canonical-import.js';
import { TabularImportError } from './import-types.js';
import { importTabularCases } from './tabular-import.js';

const fixture = (name: string): Uint8Array =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

const mappings = (format: 'csv' | 'json' | 'jsonl'): DatasetImportMapping[] => {
  const source = (field: string): string => (format === 'csv' ? field : `/${field}`);
  return [
    { destination: 'id', source: source('external_id') },
    { destination: 'input.question', source: source('prompt') },
    { destination: 'expected.answer', source: source('ideal') },
    { destination: 'params.locale', source: source('locale') },
    { destination: 'tags', source: source('tags') },
  ];
};

const diagnosticsFrom = (
  callback: () => unknown,
): readonly { code: string; line?: number; row?: number }[] => {
  try {
    callback();
  } catch (error: unknown) {
    if (error instanceof TabularImportError) return error.diagnostics;
    throw error;
  }
  throw new Error('Expected tabular import to fail.');
};

describe('tabular import golden formats', () => {
  const expected = JSON.parse(
    new TextDecoder().decode(fixture('mapped.golden.json')),
  ) as TestCase[];

  it.each([
    ['csv', 'mapped.csv'],
    ['json', 'mapped.json'],
    ['jsonl', 'mapped.jsonl'],
  ] as const)('maps the complete %s fixture to one canonical case shape', (format, name) => {
    const result = importTabularCases({
      format,
      mappings: mappings(format),
      ...(format === 'csv' ? { parseJsonSources: ['tags'] } : {}),
      ...(format === 'json' ? { recordsPointer: '/payload/rows' } : {}),
      source: fixture(name),
    });

    expect(result.cases).toEqual(expected);
    expect(result.counts).toEqual({ inserted: 2, read: 2, skipped: 0, updated: 0 });
    expect(result.preview).toEqual([
      {
        id: 'refund-1',
        input: { question: '<redacted:string>' },
        expected: { answer: '<redacted:string>' },
        params: { locale: '<redacted:string>' },
        tags: ['<redacted:string>'],
      },
      {
        id: 'refund-2',
        input: { question: '<redacted:string>' },
        expected: { answer: '<redacted:string>' },
        params: { locale: '<redacted:string>' },
        tags: ['<redacted:string>'],
      },
    ]);
  });
});

describe('tabular import validation and identity', () => {
  it('aggregates malformed JSONL and normalized-row diagnostics in physical order', () => {
    const diagnostics = diagnosticsFrom(() =>
      importTabularCases({
        format: 'jsonl',
        source: '{"input":"ok"}\nnot-json\n{"expected":"missing input"}\n{"input":}\n',
      }),
    );

    expect(diagnostics.map(({ code, line }) => ({ code, line }))).toEqual([
      { code: 'invalid_json', line: 2 },
      { code: 'invalid_union', line: 3 },
      { code: 'invalid_json', line: 4 },
    ]);
  });

  it('keeps unkeyed ids move-stable and excludes tags and metric overrides', () => {
    const logical = { input: { prompt: 'same' }, expected: 1, params: { locale: 'en' } };
    const first = importTabularCases({
      format: 'json',
      source: JSON.stringify([{ ...logical, tags: ['one'] }]),
    });
    const second = importTabularCases({
      format: 'jsonl',
      source: `${JSON.stringify({
        ...logical,
        tags: ['two'],
        metric_overrides: [{ metric_id: 'quality', threshold: 0.8 }],
      })}\n`,
    });

    expect(first.cases[0]!.id).toBe(second.cases[0]!.id);
    expect(first.cases[0]!.id).toBe(createContentCaseId(first.cases[0]!));
  });

  it('preserves sibling nested mappings and rejects prototype-mutating destinations', () => {
    const mapped = importTabularCases({
      format: 'json',
      mappings: [
        { destination: 'input.question', source: '/question' },
        { destination: 'input.context', source: '/context' },
      ],
      source: '[{"question":"where","context":"billing"}]',
    });
    expect(mapped.cases[0]?.input).toEqual({ question: 'where', context: 'billing' });

    const diagnostics = diagnosticsFrom(() =>
      importTabularCases({
        format: 'json',
        mappings: [{ destination: 'input.__proto__.polluted', source: '/value' }],
        source: '[{"value":true}]',
      }),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'mapping_destination_unsafe' }),
    );
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });

  it('rejects duplicate content by default and deterministically keeps the first when explicit', () => {
    const source = JSON.stringify([
      { id: 'first', input: 'same' },
      { id: 'second', input: 'same' },
    ]);
    expect(diagnosticsFrom(() => importTabularCases({ format: 'json', source }))).toMatchObject([
      { code: 'duplicate_content', row: 2 },
    ]);

    const deduped = importTabularCases({ dedupe: 'content', format: 'json', source });
    expect(deduped.cases.map(({ id }) => id)).toEqual(['first']);
    expect(deduped.counts).toEqual({ inserted: 1, read: 2, skipped: 1, updated: 0 });
  });

  it('reports generated-id collisions against resolved direct or attached cases', () => {
    const imported = importTabularCases({ format: 'json', source: '[{"input":"same"}]' });
    expect(
      diagnosticsFrom(() =>
        importTabularCases({
          collisionCases: imported.cases,
          format: 'json',
          source: '[{"input":"same"}]',
        }),
      ),
    ).toMatchObject([{ code: 'resolved_case_collision', row: 1 }]);
  });

  it('enforces byte, row, CSV-header, and CSV-shape limits before mutation', () => {
    expect(
      diagnosticsFrom(() =>
        importTabularCases({ format: 'json', limits: { maxBytes: 2 }, source: '[] ' }),
      ),
    ).toMatchObject([{ code: 'import_size_limit' }]);
    expect(
      diagnosticsFrom(() =>
        importTabularCases({
          format: 'json',
          limits: { maxRows: 1 },
          source: '[{"input":1},{"input":2}]',
        }),
      ),
    ).toMatchObject([{ code: 'import_row_limit' }]);
    expect(
      diagnosticsFrom(() =>
        importTabularCases({
          format: 'csv',
          mappings: [{ destination: 'input', source: 'prompt' }],
          source: 'prompt,prompt\na,b,c\n',
        }),
      ).map(({ code }) => code),
    ).toEqual(['duplicate_csv_header', 'csv_column_count']);
  });
});

describe('tabular import reconciliation policies', () => {
  const existing: TestCase[] = [
    { id: 'keep-first', input: 'old' },
    { id: 'absent-source', input: 'preserved' },
  ];

  it('requires an explicit conflict policy for append and supports skip/update in place', () => {
    const source = '[{"id":"keep-first","input":"new"}]';
    expect(
      diagnosticsFrom(() =>
        importTabularCases({ existingCases: existing, format: 'json', source }),
      ),
    ).toMatchObject([{ code: 'existing_case_conflict' }]);

    const skipped = importTabularCases({
      existingCases: existing,
      format: 'json',
      onConflict: 'skip',
      source,
    });
    expect(skipped.cases).toEqual(existing);
    expect(skipped.counts.skipped).toBe(1);

    const updated = importTabularCases({
      existingCases: existing,
      format: 'json',
      onConflict: 'update',
      source,
    });
    expect(updated.cases).toEqual([
      { id: 'keep-first', input: 'new' },
      { id: 'absent-source', input: 'preserved' },
    ]);
  });

  it('uses an explicit source key for stable upserts and never deletes absent rows', () => {
    const mapping: DatasetImportMapping[] = [{ destination: 'input', source: '/prompt' }];
    const first = importTabularCases({
      format: 'json',
      keySource: '/external_id',
      mappings: mapping,
      source: '[{"external_id":"one","prompt":"old"}]',
    });
    const stableId = createKeyedCaseId('one');
    expect(first.cases[0]!.id).toBe(stableId);

    const upserted = importTabularCases({
      existingCases: [...first.cases, { id: 'absent-source', input: 'preserved' }],
      format: 'json',
      keySource: '/external_id',
      mappings: mapping,
      source: '[{"external_id":"one","prompt":"new"},{"external_id":"two","prompt":"added"}]',
      sync: 'upsert',
    });
    expect(upserted.cases).toEqual([
      { id: stableId, input: 'new' },
      { id: 'absent-source', input: 'preserved' },
      { id: createKeyedCaseId('two'), input: 'added' },
    ]);
    expect(upserted.counts).toEqual({ inserted: 1, read: 2, skipped: 0, updated: 1 });
  });

  it('rejects content-derived upserts whose changed content cannot retain identity', () => {
    expect(
      diagnosticsFrom(() =>
        importTabularCases({ format: 'json', source: '[{"input":"value"}]', sync: 'upsert' }),
      ),
    ).toMatchObject([{ code: 'upsert_identity_required' }]);
  });
});
