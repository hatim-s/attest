/** JSON.stringify replacer that emits object keys in code-unit order. */
const sortObjectKeys = (_key: string, value: unknown): unknown => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => (left < right ? -1 : 1)),
  );
};

/** Serializes JSON so that key insertion order does not affect equality or output. */
const canonicalJson = (value: unknown, indentation?: number): string =>
  JSON.stringify(value, sortObjectKeys, indentation);

export { canonicalJson };
