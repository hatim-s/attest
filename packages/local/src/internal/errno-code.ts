/** Reads the Node.js system error code, such as `ENOENT` or `EEXIST`, from a failed fs call. */
// BOUNDARY: Filesystem calls may reject with arbitrary values; accept only Error objects with string system codes.
const errnoCode = (cause: unknown): string | undefined =>
  cause instanceof Error && 'code' in cause && typeof cause.code === 'string'
    ? cause.code
    : undefined;

export { errnoCode };
