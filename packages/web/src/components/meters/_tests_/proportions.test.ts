import { describe, expect, it } from 'vitest';
import { allocateSlots, countsLabel, METER_SLOTS, type VerdictCounts } from '../proportions.js';

const empty = { passed: 0, failed: 0, errored: 0, skipped: 0, notRun: 0 } satisfies VerdictCounts;

describe('aggregate slots', () => {
  it('conserves the budget and fixed category order with deterministic rounding ties', () => {
    const counts = { passed: 1, failed: 1, errored: 1, skipped: 0, notRun: 0 };
    const slots = allocateSlots(counts);
    expect(slots).toEqual([
      { kind: 'error', slots: 14 },
      { kind: 'fail', slots: 13 },
      { kind: 'skipped', slots: 0 },
      { kind: 'notRun', slots: 0 },
      { kind: 'pass', slots: 13 },
    ]);
    expect(allocateSlots(counts)).toEqual(slots);
    expect(slots.reduce((sum, segment) => sum + segment.slots, 0)).toBe(METER_SLOTS);
  });

  it('preserves one failure and one error even among a million passes', () => {
    expect(allocateSlots({ ...empty, passed: 1_000_000, failed: 1, errored: 1 })).toEqual([
      { kind: 'error', slots: 1 },
      { kind: 'fail', slots: 1 },
      { kind: 'skipped', slots: 0 },
      { kind: 'notRun', slots: 0 },
      { kind: 'pass', slots: 38 },
    ]);
  });

  it('handles empty, single and partial populations without inventing identities', () => {
    expect(allocateSlots(empty).every((segment) => segment.slots === 0)).toBe(true);
    expect(
      allocateSlots({ ...empty, failed: 1 }).find((segment) => segment.kind === 'fail')?.slots,
    ).toBe(40);
    expect(
      allocateSlots({ ...empty, passed: 1, skipped: 1, notRun: 2 }).map((segment) => segment.slots),
    ).toEqual([0, 0, 10, 20, 10]);
    expect(countsLabel({ ...empty, notRun: null })).toContain('unknown number not run');
  });

  it('never loses a positive failure category or changes the slot budget across mixed counts', () => {
    for (let passed = 0; passed < 60; passed += 7) {
      for (let failed = 0; failed < 4; failed++) {
        for (let errored = 0; errored < 4; errored++) {
          const counts = { passed, failed, errored, skipped: 2, notRun: 3 };
          const slots = allocateSlots(counts);
          expect(slots.reduce((sum, item) => sum + item.slots, 0)).toBe(40);
          expect(slots.every((item) => Number.isInteger(item.slots) && item.slots >= 0)).toBe(true);

          if (failed > 0)
            expect(slots.find((item) => item.kind === 'fail')?.slots).toBeGreaterThan(0);

          if (errored > 0)
            expect(slots.find((item) => item.kind === 'error')?.slots).toBeGreaterThan(0);
        }
      }
    }
  });
});

it('uses exact rational ties across unequal counts and the full safe integer domain', () => {
  expect(
    allocateSlots({ passed: 1, failed: 4, errored: 1, skipped: 0, notRun: 0 }).map(
      ({ slots }) => slots,
    ),
  ).toEqual([7, 27, 0, 0, 6]);
  expect(
    allocateSlots({
      passed: Number.MAX_SAFE_INTEGER,
      failed: Number.MAX_SAFE_INTEGER,
      errored: Number.MAX_SAFE_INTEGER,
      skipped: 0,
      notRun: null,
    }).map(({ slots }) => slots),
  ).toEqual([14, 13, 0, 0, 13]);
  expect(() => allocateSlots({ ...empty, passed: Infinity })).toThrow(RangeError);
});
