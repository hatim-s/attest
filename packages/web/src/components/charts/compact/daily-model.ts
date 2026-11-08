import type { Activity } from '@attest/core/records';

type ActivityDay = Activity['days'][number];

/** Inclusive window of UTC calendar days, 1 to 92 long. Activity buckets are always UTC. */
type ActivityWindow = { from: string; to: string };

const ACTIVITY_LIMIT = 92;

/** One shared count scale keeps the passing and failing bar lengths comparable. */
function prepareActivity(days: readonly ActivityDay[], window: ActivityWindow) {
  const parseDay = (value: string) => {
    const time = Date.parse(`${value}T00:00:00Z`);

    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value)
      throw new RangeError('Invalid calendar day');

    return time;
  };

  const from = parseDay(window.from),
    to = parseDay(window.to);

  const length = (to - from) / 86_400_000 + 1;

  if (!Number.isInteger(length) || length < 1 || length > ACTIVITY_LIMIT)
    throw new RangeError('Activity window must contain 1 to 92 inclusive days');

  if (days.length > ACTIVITY_LIMIT)
    throw new RangeError(`Activity window exceeds ${ACTIVITY_LIMIT} days`);
  const supplied = new Map(days.map((day) => [day.day, day]));

  if (
    supplied.size !== days.length ||
    days.some((day) => parseDay(day.day) < from || parseDay(day.day) > to)
  )
    throw new RangeError('Duplicate or out-of-window activity day');

  // UTC arithmetic matches the backend buckets and avoids host DST drift.
  const ordered = Array.from({ length }, (_, index) => {
    const day = new Date(from + index * 86_400_000).toISOString().slice(0, 10);

    return supplied.get(day) ?? { day, slices: 0, passed: 0, failed: 0, errored: 0, skipped: 0 };
  });

  const up = Math.max(0, ...ordered.map((day) => day.passed));
  const down = Math.max(0, ...ordered.map((day) => day.failed + day.errored));

  const totals = ordered.reduce(
    (sum, day) => ({
      slices: sum.slices + day.slices,
      passed: sum.passed + day.passed,
      failed: sum.failed + day.failed,
      errored: sum.errored + day.errored,
      skipped: sum.skipped + day.skipped,
    }),
    { slices: 0, passed: 0, failed: 0, errored: 0, skipped: 0 },
  );

  return { ordered, up, down, totals };
}

/**
 * The days an activity response actually covers. `coveredTo` is exclusive and a truncated read
 * moves `coveredFrom` forward, so the chart never draws a partial day as if it were complete.
 * Returns null when nothing is covered.
 */
function activityWindow(
  activity: Pick<Activity, 'coveredFrom' | 'coveredTo'>,
): ActivityWindow | null {
  const from = new Date(Date.parse(activity.coveredFrom)).toISOString().slice(0, 10);
  const to = new Date(Date.parse(activity.coveredTo) - 1).toISOString().slice(0, 10);

  return from <= to ? { from, to } : null;
}

export { prepareActivity, activityWindow, ACTIVITY_LIMIT, type ActivityDay, type ActivityWindow };
