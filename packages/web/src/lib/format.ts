/** Shows milliseconds under one second, seconds under one minute, then minutes and seconds. */
const formatDuration = (milliseconds: number): string => {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;

  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(2)} s`;

  return `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1_000)}s`;
};

const startOfLocalDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/**
 * When something started, in the viewer's time zone: "Today 11:05", "Yesterday 09:12",
 * "Oct 5 17:20", with the year only when it is not the current one.
 */
const formatStarted = (value: string, now = new Date()): string => {
  const date = new Date(value);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  // Rounding absorbs the hour a daylight-saving change adds or removes.
  const days = Math.round((startOfLocalDay(now) - startOfLocalDay(date)) / 86_400_000);

  if (days <= 0) return `Today ${time}`;

  if (days === 1) return `Yesterday ${time}`;

  const day = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });

  return `${day} ${time}`;
};

/** Formats a zero-to-one rate as a percentage. */
const formatPercent = (rate: number | undefined): string =>
  rate === undefined ? '—' : `${(rate * 100).toFixed(rate === 0 || rate === 1 ? 0 : 1)}%`;

/** Counts a noun for prose, so a single run never reads as "1 runs". */
const formatCount = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * A run id short enough for a table. Run ids are ULIDs: runs started within the same second share
 * their leading time characters, so the short form is the random tail.
 */
const shortRunId = (runId: string): string => runId.slice(-6);

/** A commit sha in the usual seven-character form. */
const shortSha = (sha: string): string => sha.slice(0, 7);

export { formatCount, formatDuration, formatPercent, formatStarted, shortRunId, shortSha };
