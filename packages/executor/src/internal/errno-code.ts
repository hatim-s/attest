/** Reads the errno code from a Node system error so callers can branch without casts. */
const errnoCode = (error: unknown): string | undefined => {
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
};

export { errnoCode };
