import { describe, expect, it } from 'vitest';
import { selectCases, type SelectableCase } from '../select-cases.js';

const population: SelectableCase[] = Array.from({ length: 100 }, (_, index) => ({
  test_id: index < 50 ? 'alpha' : 'beta',
  case: {
    id: `case-${index % 50}`,
    tags: index % 2 === 0 ? ['smoke', 'api'] : ['api'],
    folder: index % 2 === 0 ? 'billing/refunds' : 'billing-other',
  },
  source: index < 50 ? { kind: 'direct' } : { kind: 'dataset', dataset_id: 'shared' },
}));
const keys = (cases: readonly SelectableCase[]) =>
  cases.map((item) => `${item.test_id}/${item.case.id}`);

describe('core case selection', () => {
  it('pins hash-rank-v1 membership', () => {
    const candidates: SelectableCase[] = Array.from({ length: 10 }, (_, index) => ({
      test_id: 'test',
      case: { id: `case-${index}` },
      source: { kind: 'direct' },
    }));
    expect(
      selectCases(candidates, { sample: { count: 3, seed: 'v1' } }).cases.map(
        ({ case: testCase }) => testCase.id,
      ),
    ).toEqual(['case-1', 'case-2', 'case-6']);
  });

  it('samples the combined population reproducibly while retaining configured order', () => {
    const selection = { sample: { count: 25, seed: 'review-42' } };
    const first = selectCases(population, selection);
    expect(first.cases).toHaveLength(25);
    expect(selectCases(population, selection)).toEqual(first);
    const reversed = selectCases([...population].reverse(), selection);
    expect(keys(reversed.cases).sort()).toEqual(keys(first.cases).sort());
    expect(first.cases.map((item) => population.indexOf(item))).toEqual(
      first.cases.map((item) => population.indexOf(item)).sort((a, b) => a - b),
    );
    expect(new Set(keys(first.cases)).size).toBe(25);
    expect(selectCases(population, { sample: { count: 25, seed: 'other' } }).cases).not.toEqual(
      first.cases,
    );
  });

  it('intersects filters before sampling and respects folder segment boundaries', () => {
    const result = selectCases(population, {
      tags: ['smoke', 'api'],
      folders: ['billing'],
      dataset_ids: ['shared'],
      sample: { count: 10, seed: 'fixed' },
    });
    expect(result.summary).toMatchObject({
      total_cases: 100,
      matched_cases: 25,
      selected_cases: 10,
    });
    expect(
      result.cases.every(
        (item) => item.source.kind === 'dataset' && item.case.folder === 'billing/refunds',
      ),
    ).toBe(true);
    expect(selectCases(population, { case_ids: ['case-0'] }).cases).toHaveLength(2);
  });

  it('caps oversized samples and records an automatically generated replayable seed', () => {
    const result = selectCases(population, { sample: { count: 200 } });
    expect(result.cases).toEqual(population);
    expect(result.summary.sample?.seed).toBeTruthy();
    const sample = selectCases(population, { sample: { count: 10 } });
    expect(selectCases(population, { sample: sample.summary.sample }).cases).toEqual(sample.cases);
  });

  it('rejects empty matches, missing ids, and duplicate identities', () => {
    expect(() => selectCases(population, { tags: ['missing'] })).toThrow('No cases matched');
    expect(() => selectCases(population, { case_ids: ['missing'] })).toThrow('do not exist');
    expect(() => selectCases([population[0]!, population[0]!])).toThrow(
      'Duplicate case identities',
    );
    expect(() => selectCases(population, { tags: ['api', 'api'] })).toThrow('Duplicate selection');
  });
});
