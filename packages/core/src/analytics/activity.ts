import type { Activity } from '../records/dashboard-schemas.js';

/** Most eval slices one activity request reads; denser intervals report truncation. */
const ACTIVITY_SLICE_LIMIT = 10_000;

const DAY_MS = 86_400_000;

/** The counts of one stored eval slice that cases-per-day needs. */
type ActivitySlice = {
  createdAt: string;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
};

/**
 * Buckets eval slices into UTC days. `slices` are newest first and hold at most
 * ACTIVITY_SLICE_LIMIT + 1 rows from `[from, to)`; the extra row only signals truncation.
 * When truncated, the oldest UTC day is dropped whole, ties included, so no partial day looks
 * exact, and `coveredFrom` moves to the first fully covered day.
 */
const bucketActivity = (
  slices: readonly ActivitySlice[],
  bounds: { from: string; to: string },
): Activity => {
  const boundary = slices[ACTIVITY_SLICE_LIMIT];

  const cutoff =
    boundary === undefined
      ? bounds.from
      : new Date(
          Date.parse(`${boundary.createdAt.slice(0, 10)}T00:00:00.000Z`) + DAY_MS,
        ).toISOString();

  const days = new Map<string, Activity['days'][number]>();

  for (const slice of slices.slice(0, ACTIVITY_SLICE_LIMIT)) {
    if (slice.createdAt < cutoff) continue;
    const day = slice.createdAt.slice(0, 10);

    const bucket = days.get(day) ?? {
      day,
      slices: 0,
      passed: 0,
      failed: 0,
      errored: 0,
      skipped: 0,
    };

    days.set(day, {
      day,
      slices: bucket.slices + 1,
      passed: bucket.passed + slice.passed,
      failed: bucket.failed + slice.failed,
      errored: bucket.errored + slice.errored,
      skipped: bucket.skipped + slice.skipped,
    });
  }

  return {
    coveredFrom: cutoff > bounds.to ? bounds.to : cutoff,
    coveredTo: bounds.to,
    timezone: 'UTC',
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    truncated: boundary !== undefined,
  };
};

export { ACTIVITY_SLICE_LIMIT, bucketActivity, type ActivitySlice };
