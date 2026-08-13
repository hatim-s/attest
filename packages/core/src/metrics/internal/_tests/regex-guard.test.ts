import { describe, expect, it } from 'vitest';

import { executeGuardedRegexTest } from '../regex-guard.js';

describe('executeGuardedRegexTest', () => {
  it('distinguishes matches from non-matches', () => {
    expect(executeGuardedRegexTest({ pattern: '^Paris$', input: 'Paris' })).toEqual({
      kind: 'matched',
    });
    expect(executeGuardedRegexTest({ pattern: '^Paris$', input: 'paris' })).toEqual({
      kind: 'unmatched',
    });
  });

  it('rejects UTF-8 input beyond the byte limit before regex execution', () => {
    expect(executeGuardedRegexTest({ pattern: '.', input: '🇫🇷', maxInputBytes: 7 })).toEqual({
      kind: 'input_too_large',
      limitBytes: 7,
    });
  });
});
