import { parseWithSchema } from '@attest/contracts';
import { describe, expect, it } from 'vitest';

import { utcTimestampSchema } from '../utc-timestamp.js';

describe('local UTC metadata timestamps', () => {
  it('retains precision and rejects offsets and normalized calendar dates', () => {
    for (const value of [
      '2024-02-29T12:34Z',
      '2024-02-29T12:34:56Z',
      '2024-02-29T12:34:56.123456Z',
    ]) {
      expect(parseWithSchema(utcTimestampSchema, value)).toEqual({ ok: true, value });
    }

    for (const value of ['2023-02-29T12:34Z', '2024-04-31T12:34Z', '2024-01-01T12:34:56+00:00']) {
      expect(parseWithSchema(utcTimestampSchema, value).ok).toBe(false);
    }
  });
});
