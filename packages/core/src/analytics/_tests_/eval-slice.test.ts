import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../../store/types.js';
import { emptySliceTotals, toEvalSlice, summarizeEvalSlices } from '../eval-slice.js';

const run: RunRecord = {
  id: 'run',
  schemaId: 'legacy',
  configHash: 'hash',
  configJson: '{}',
  createdAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:01:00.000Z',
  status: 'failed',
};

const recorded = { ...emptySliceTotals(2), recorded: 2, passed: 1, failed: 1 };

describe('eval completeness', () => {
  it('allows a complete slice inside a failed multi-eval run', () => {
    expect(toEvalSlice(recorded, run, 'good')).toMatchObject({
      state: 'complete',
      passRate: 0.5,
      runStatus: 'failed',
    });
    expect(toEvalSlice({ ...recorded, failed: 0, errored: 1 }, run, 'bad')).toMatchObject({
      state: 'incomplete',
      passRate: null,
    });
  });
  it('keeps partial, skipped, unknown and empty coverage honest', () => {
    for (const totals of [
      { ...recorded, planned: 3 },
      { ...recorded, planned: null },
      emptySliceTotals(0),
      { ...recorded, failed: 0, skipped: 1 },
    ])
      expect(toEvalSlice(totals, run, 'test').passRate).toBeNull();
    expect(
      toEvalSlice(recorded, { ...run, status: 'running', finishedAt: undefined }, 'test').state,
    ).toBe('running');
    expect(() => toEvalSlice({ ...recorded, planned: 1 }, run, 'test')).toThrow('exceed');
  });
});

it('keeps a running latest slice from replacing the last terminal verdict', () => {
  const complete = toEvalSlice(recorded, run, 'test');

  const running = toEvalSlice(
    recorded,
    { ...run, id: 'new', status: 'running', finishedAt: undefined },
    'test',
  );

  expect(summarizeEvalSlices(running, complete, null)).toMatchObject({
    latest: { state: 'running' },
    latestTerminal: { state: 'complete' },
    failing: true,
  });
  expect(summarizeEvalSlices(running, null, null).failing).toBeNull();
});
