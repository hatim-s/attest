import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { schemaVersionOneSql } from './registry.js';

describe('migration registry', () => {
  it('keeps the emitted schema-v1 SQL byte-identical to its reviewable source', async () => {
    const source = await readFile(new URL('./0001_schema_v1.sql', import.meta.url), 'utf8');
    expect(schemaVersionOneSql).toBe(source);
  });
});
