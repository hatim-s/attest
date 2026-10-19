import type { RunPage, RunRecord } from '@attest/core/records';
import { expect, it } from 'vitest';
import { formatPageRunCount, sortByLatestRun } from '../routes/project-rows.js';

const run = (createdAt: string): RunRecord => ({
  id: `run-${createdAt}`,
  schemaId: 'attest.project',
  configHash: 'hash',
  configJson: '{}',
  createdAt,
  status: 'running',
});

const page = (...createdAt: string[]): RunPage => ({ items: createdAt.map(run) });

it('sorts projects by newest run and puts projects without runs last in catalog order', () => {
  const rows = [
    { key: 'unloaded', page: undefined },
    { key: 'older', page: page('2026-10-17T09:00:00Z') },
    { key: 'empty', page: page() },
    // Fractional seconds sort before `Z` as strings, so only an instant comparison gets this right.
    { key: 'newer', page: page('2026-10-17T09:00:00.500Z', '2026-10-01T00:00:00Z') },
    { key: 'newest', page: page('2026-10-18T00:00:00Z') },
  ];

  expect(sortByLatestRun(rows).map((row) => row.key)).toEqual([
    'newest',
    'newer',
    'older',
    'unloaded',
    'empty',
  ]);
});

it('marks a runs page with more runs behind its cursor as 100+', () => {
  const items = Array.from({ length: 100 }, (_, index) =>
    run(`2026-10-18T00:00:${String(index % 60).padStart(2, '0')}Z`),
  );

  expect(formatPageRunCount({ items, nextCursor: 'next' })).toBe('100+');
  expect(formatPageRunCount({ items })).toBe('100');
  expect(formatPageRunCount(page('2026-10-18T00:00:00Z'))).toBe('1');
});
