import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { initialSchemaSql } from '../registry.js';

describe('migration registry', () => {
  it('keeps the emitted initial schema SQL byte-identical to its reviewable source', async () => {
    const source = await readFile(new URL('../0001_initial.sql', import.meta.url), 'utf8');
    expect(initialSchemaSql).toBe(source);
  });
});
