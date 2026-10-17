import { describe, expect, it } from 'vitest';

import { formatShortDateTime } from '../../../lib/format.js';
import { runTickLabels } from '../analytics-chart.js';

describe('runTickLabels', () => {
  it('adds precision only to ticks that would collide', () => {
    const sameMinute = [
      { id: '01M54DZY0001ZPGCE7HQ84RG6B', createdAt: '2026-08-07T10:15:20.100Z' },
      { id: '01M54DZYB82RBDEYPPAB44XA6M', createdAt: '2026-08-07T10:15:20.460Z' },
    ];

    const minuteApart = [
      { id: '01M54E0000000000000000000A', createdAt: '2026-08-07T10:15:00.000Z' },
      { id: '01M54E1000000000000000000B', createdAt: '2026-08-07T10:16:00.000Z' },
    ];

    const [first, second] = runTickLabels(sameMinute);
    expect(first).not.toBe(second);
    expect(runTickLabels(minuteApart)).toEqual(
      minuteApart.map(({ createdAt }) => formatShortDateTime(createdAt)),
    );
  });
});
