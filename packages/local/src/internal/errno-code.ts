/** Reads the Node.js system error code, such as `ENOENT` or `EEXIST`, from a failed fs call. */
const errnoCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;

export { errnoCode };
