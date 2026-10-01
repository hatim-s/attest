/** Represents an expected success or failure without using exceptions for normal control flow. */
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/** Creates a successful result while preserving the value's inferred type. */
const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

/** Creates a failed result while preserving the error's inferred type. */
const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export { err, ok, type Result };
