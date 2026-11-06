type ActivityDay = {
  /** Calendar day in the timezone chosen by the API caller, YYYY-MM-DD. */
  day: string;
  runCount: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
};

type ActivityWindow = { from: string; to: string; utcOffsetMinutes: number };

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

  if (
    !Number.isInteger(window.utcOffsetMinutes) ||
    window.utcOffsetMinutes < -720 ||
    window.utcOffsetMinutes > 840
  )
    throw new RangeError('Invalid activity UTC offset');

  if (days.length > ACTIVITY_LIMIT)
    throw new RangeError(`Activity window exceeds ${ACTIVITY_LIMIT} days`);
  const supplied = new Map(days.map((day) => [day.day, day]));

  if (
    supplied.size !== days.length ||
    days.some((day) => parseDay(day.day) < from || parseDay(day.day) > to)
  )
    throw new RangeError('Duplicate or out-of-window activity day');

  // Calendar labels already use the declared offset; UTC arithmetic avoids host DST drift.
  const ordered = Array.from({ length }, (_, index) => {
    const day = new Date(from + index * 86_400_000).toISOString().slice(0, 10);

    return supplied.get(day) ?? { day, runCount: 0, passed: 0, failed: 0, errored: 0, skipped: 0 };
  });

  const up = Math.max(1, ...ordered.map((day) => day.passed));
  const down = Math.max(1, ...ordered.map((day) => day.failed + day.errored));

  const totals = ordered.reduce(
    (sum, day) => ({
      runCount: sum.runCount + day.runCount,
      passed: sum.passed + day.passed,
      failed: sum.failed + day.failed,
      errored: sum.errored + day.errored,
      skipped: sum.skipped + day.skipped,
    }),
    { runCount: 0, passed: 0, failed: 0, errored: 0, skipped: 0 },
  );

  return { ordered, up, down, totals };
}

export { prepareActivity, ACTIVITY_LIMIT, type ActivityDay, type ActivityWindow };
