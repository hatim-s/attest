const MAX_RETRY_AFTER_MS = 30_000;

/** Parses standard Retry-After values while enforcing the common transport ceiling. */
const parseRetryAfter = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  if (/^\d+$/u.test(value.trim())) {
    return Math.min(Number(value.trim()) * 1_000, MAX_RETRY_AFTER_MS);
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.min(Math.max(0, timestamp - Date.now()), MAX_RETRY_AFTER_MS)
    : undefined;
};

export { parseRetryAfter };
