import { describe, expect, it } from 'vitest';

import { formatDuration, formatPercent, shortId } from './format.js';

describe('dashboard formatters', () => {
  it('keeps duration and pass-rate summaries compact', () => {
    expect(formatDuration(85)).toBe('85 ms');
    expect(formatDuration(1_250)).toBe('1.25 s');
    expect(formatDuration(61_000)).toBe('1m 1s');
    expect(formatPercent(0.875)).toBe('87.5%');
  });

  it('shortens opaque run identifiers deterministically', () => {
    expect(shortId('01K2EXAMPLE', 6)).toBe('01K2EX');
  });
});
