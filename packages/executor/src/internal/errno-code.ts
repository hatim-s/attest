/** BOUNDARY: validates the optional errno string on arbitrary rejected Node operations. Reads the errno code from a Node system error so callers can branch without casts. */
const errnoCode = (cause: unknown): string | undefined => {
  if (cause === null || typeof cause !== 'object' || !('code' in cause)) return undefined;

  return typeof cause.code === 'string' ? cause.code : undefined;
};

export { errnoCode };
