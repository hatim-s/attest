type ActivityDay = {
  /** Calendar day in the timezone chosen by the API caller, YYYY-MM-DD. */
  day: string;
  runCount: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
};

const ACTIVITY_LIMIT = 92;

/** One shared count scale keeps the passing and failing bar lengths comparable. */
function prepareActivity(days: readonly ActivityDay[]) {
  if (days.length > ACTIVITY_LIMIT)
    throw new RangeError(`Activity window exceeds ${ACTIVITY_LIMIT} days`);
  const ordered = [...days].sort((a, b) => a.day.localeCompare(b.day, 'en'));
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

export { prepareActivity, ACTIVITY_LIMIT, type ActivityDay };
