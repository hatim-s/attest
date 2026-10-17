import { describe, expect, it } from 'vitest';

import { evalRunRequestSchema } from '../eval/run.js';

const request = {
  schema: 'attest.command-request',
  command: 'eval.run',
  output: 'json',
  test_ids: ['smoke'],
};

describe('eval run selection uniqueness', () => {
  it.each([
    ['test_ids', 'test id'],
    ['case_ids', 'case id'],
    ['tags', 'tag'],
    ['folders', 'folder'],
    ['dataset_ids', 'dataset id'],
  ])('rejects a repeated %s value at its index', (field, label) => {
    const parsed = evalRunRequestSchema.safeParse({ ...request, [field]: ['smoke', 'smoke'] });

    expect(parsed.error?.issues).toEqual([
      { code: 'custom', path: [field, 1], message: `duplicate ${label}: smoke` },
    ]);
  });
});
