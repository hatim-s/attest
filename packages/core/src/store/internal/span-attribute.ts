/** Converts only trace-contract scalar values into denormalized searchable columns. */
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
