import type { RunRecord } from '@attest/core/records';

/** Formats a timestamp in the browser locale, or a dash when absent. */
const formatDateTime = (value: string | undefined): string => {
  if (value === undefined) return '—';
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

/** Month, day and time without the year, short enough for a chart tick. */
const formatShortDateTime = (value: string, precision: 'minute' | 'second' = 'minute'): string =>
  new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: precision === 'second' ? '2-digit' : undefined,
  });

/** Shows milliseconds under one second, seconds under one minute, then minutes and seconds. */
const formatDuration = (milliseconds: number): string => {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;

  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(2)} s`;

  return `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1_000)}s`;
};

/** Writes the unit once when both ends share it, as in "0 to 237 ms" or "1.42 to 1.66 s". */
const formatDurationRange = (lowerMs: number, upperMs: number): string => {
  if (upperMs < 1_000) return `${Math.round(lowerMs)} to ${Math.round(upperMs)} ms`;

  if (lowerMs >= 1_000 && upperMs < 60_000) {
    return `${(lowerMs / 1_000).toFixed(2)} to ${(upperMs / 1_000).toFixed(2)} s`;
  }

  return `${formatDuration(lowerMs)} to ${formatDuration(upperMs)}`;
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

/** Formats the share of passing cases. A run with no cases shows a dash, not 0% or 100%. */
const formatPassRate = (run: RunRecord): string => {
  if (run.summary === undefined || run.summary.totalCases === 0) return formatPercent(undefined);

  return formatPercent(run.summary.passedCases / run.summary.totalCases);
};

/** Counts a noun for prose, so a single run never reads as "1 runs". */
const formatCount = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;

/** Truncates an opaque identifier for display. */
const shortId = (value: string, length = 8): string => value.slice(0, length);

/**
 * A run id short enough for a table. Run ids are ULIDs: runs started within the same second share
 * their leading time characters, so the short form is the random tail.
 */
const shortRunId = (runId: string): string => runId.slice(-6);

/** A commit sha in the usual seven-character form. */
const shortSha = (sha: string): string => sha.slice(0, 7);

export {
  formatCount,
  formatDateTime,
  formatDuration,
  formatDurationRange,
  formatPassRate,
  formatPercent,
  formatShortDateTime,
  formatStarted,
  shortId,
  shortRunId,
  shortSha,
};
