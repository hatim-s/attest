/** Converts only trace-contract scalar values into denormalized searchable columns. */
// BOUNDARY: Trace extension attributes are untrusted; accept only finite scalar values before storing indexed text.
const toSpanAttribute = (value: unknown): string | null => {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return null;
};

export { toSpanAttribute };
