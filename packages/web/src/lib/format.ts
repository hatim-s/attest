/** Formats a timestamp using the browser locale while preserving a stable empty fallback. */
const formatDateTime = (value: string | undefined): string => {
  if (value === undefined) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

/** Keeps duration labels readable across fast invocations and multi-second cases. */
const formatDuration = (milliseconds: number): string => {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(2)} s`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1_000)}s`;
};

/** Presents pass rates from the core's zero-to-one representation. */
const formatPercent = (rate: number | undefined): string =>
  rate === undefined ? '—' : `${(rate * 100).toFixed(rate === 0 || rate === 1 ? 0 : 1)}%`;

/** Truncates opaque identifiers while keeping enough entropy for local comparison. */
const shortId = (value: string, length = 8): string => value.slice(0, length);

export { formatDateTime, formatDuration, formatPercent, shortId };
