const PROJECT_RANGES = [14, 28] as const;

type ProjectRange = (typeof PROJECT_RANGES)[number];

const DAY_MS = 86_400_000;

const RANGE_NAMES = { 14: '2 weeks', 28: '4 weeks' } satisfies Record<ProjectRange, string>;

/**
 * The last `days` UTC calendar days through `today` (days since the epoch), as the half-open
 * `[from, to)` interval the activity and eval-run reads take. UTC matches the activity buckets.
 */
const projectWindow = (days: ProjectRange, today: number) => {
  const to = (today + 1) * DAY_MS;

  return { from: new Date(to - days * DAY_MS).toISOString(), to: new Date(to).toISOString() };
};

const utcDay = (value: number) =>
  new Date(value).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

/** "Oct 26 to Nov 8": the first and last UTC day in the window. */
const rangeLabel = ({ from, to }: { from: string; to: string }) =>
  `${utcDay(Date.parse(from))} to ${utcDay(Date.parse(to) - 1)}`;

/** Changes once per UTC day, so query keys built from the window stay stable between renders. */
const utcToday = () => Math.floor(Date.now() / DAY_MS);

export { PROJECT_RANGES, RANGE_NAMES, projectWindow, rangeLabel, utcToday, type ProjectRange };
