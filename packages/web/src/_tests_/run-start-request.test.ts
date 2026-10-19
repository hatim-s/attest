import { expect, it } from 'vitest';
import { selectTests, toRunStartRequest } from '../routes/run-start-request.js';

const testIds = ['smoke', 'billing', 'refunds'];

it('selects all tests when nothing is unchecked, the checked ids otherwise, and nothing when none are', () => {
  expect(selectTests(testIds, new Set())).toEqual({ all: true });
  expect(selectTests(testIds, new Set(['billing']))).toEqual({ testIds: ['smoke', 'refunds'] });
  expect(selectTests(testIds, new Set(['smoke', 'refunds']))).toEqual({ testIds: ['billing'] });
  // An id the list no longer has does not count as an unchecked test.
  expect(selectTests(testIds, new Set(['gone']))).toEqual({ all: true });
  expect(selectTests(testIds, new Set(testIds))).toBeUndefined();
  expect(selectTests([], new Set())).toBeUndefined();
});

it('omits blank fields, splits and trims tags, and sends the timeout in milliseconds', () => {
  const selection = { all: true } as const;

  expect(toRunStartRequest({ selection, tags: '', concurrency: '', timeoutSeconds: '' })).toEqual({
    selection,
  });
  expect(
    toRunStartRequest({ selection, tags: ' , ,', concurrency: '  ', timeoutSeconds: ' ' }),
  ).toEqual({ selection });
  expect(
    toRunStartRequest({
      selection: { testIds: ['smoke'] },
      tags: ' smoke, fast ,,billing ',
      concurrency: '4',
      timeoutSeconds: '90',
    }),
  ).toEqual({
    selection: { testIds: ['smoke'] },
    tags: ['smoke', 'fast', 'billing'],
    concurrency: 4,
    timeoutMs: 90_000,
  });
});
