const segmentOrder = ['error', 'fail', 'skipped', 'notRun', 'pass'] as const;

type VerdictCounts = {
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  notRun: number | null;
};

const countKeys = {
  error: 'errored',
  fail: 'failed',
  skipped: 'skipped',
  notRun: 'notRun',
  pass: 'passed',
} as const;

const METER_SLOTS = 40;

/** Largest remainders conserve the fixed slot budget; ties use verdict order. */
function allocateSlots(counts: VerdictCounts) {
  const total = segmentOrder.reduce((sum, kind) => sum + (counts[countKeys[kind]] ?? 0), 0);

  if (total === 0) return segmentOrder.map((kind) => ({ kind, slots: 0 }));

  const shares = segmentOrder.map((kind, index) => {
    const exact = ((counts[countKeys[kind]] ?? 0) / total) * METER_SLOTS;

    return { kind, index, slots: Math.floor(exact), remainder: exact % 1 };
  });

  const remaining = METER_SLOTS - shares.reduce((sum, share) => sum + share.slots, 0);
  const ranked = [...shares].sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  for (const share of ranked.slice(0, remaining)) share.slots += 1;

  // Preserve evidence of even one error/failure in an otherwise large passing run.
  for (const share of shares) {
    if (
      (share.kind === 'error' || share.kind === 'fail') &&
      counts[countKeys[share.kind]] > 0 &&
      share.slots === 0
    ) {
      const donor = [...shares].sort((a, b) => b.slots - a.slots || a.index - b.index)[0];

      if (donor) {
        donor.slots -= 1;
        share.slots = 1;
      }
    }
  }

  return shares.map(({ kind, slots }) => ({ kind, slots }));
}

/** Exact counts remain available even when a small category rounds to zero marks. */
function countsLabel(counts: VerdictCounts) {
  return `${counts.passed} passed, ${counts.failed} failed, ${counts.errored} errored, ${counts.skipped} skipped, ${counts.notRun === null ? 'unknown number' : counts.notRun} not run`;
}

export { allocateSlots, countsLabel, METER_SLOTS, type VerdictCounts };
