import type { RunRecord } from '@attest/core/records';

/** Formats a timestamp in the browser locale, or a dash when absent. */
const formatDateTime = (value: string | undefined): string => {
  if (value === undefined) return '—';
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

/** Month, day and time without the year, short enough for a chart tick. */
const formatShortDateTime = (value: string): string =>
  new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
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

export {
  formatCount,
  formatDateTime,
  formatDuration,
  formatDurationRange,
  formatPassRate,
  formatPercent,
  formatShortDateTime,
  shortId,
};
