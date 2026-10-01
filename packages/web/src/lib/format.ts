import type { RunRecord } from '../api/types.js';

/** Formats a timestamp in the browser locale, or a dash when absent. */
const formatDateTime = (value: string | undefined): string => {
  if (value === undefined) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

/** Shows milliseconds under one second, seconds under one minute, then minutes and seconds. */
const formatDuration = (milliseconds: number): string => {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(2)} s`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1_000)}s`;
};

/** Formats a zero-to-one rate as a percentage. */
const formatPercent = (rate: number | undefined): string =>
  rate === undefined ? '—' : `${(rate * 100).toFixed(rate === 0 || rate === 1 ? 0 : 1)}%`;

/** Formats the share of passing cases. A run with no cases shows a dash, not 0% or 100%. */
const formatPassRate = (run: RunRecord): string => {
  if (run.summary === undefined || run.summary.totalCases === 0) return formatPercent(undefined);
  return formatPercent(run.summary.passedCases / run.summary.totalCases);
};

/** Truncates an opaque identifier for display. */
const shortId = (value: string, length = 8): string => value.slice(0, length);

export { formatDateTime, formatDuration, formatPassRate, formatPercent, shortId };
