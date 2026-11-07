import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';

import { StoreError, type StoreErrorCode } from '@attest/core';

type StoreFailureCode = Extract<StoreErrorCode, 'READ_FAILED' | 'WRITE_FAILED'>;

/** Records failed cleanup without replacing a primary failure, defect or interruption. */
class StoreCleanup extends Context.Service<StoreCleanup, Cause.Cause<StoreError>>()(
  'attest/StoreCleanup',
) {}

/** Wraps one driver call, preserving deliberate domain failures and their identity. */
const storeCall = <A>(code: StoreFailureCode, message: string, call: () => Promise<A>) =>
  Effect.tryPromise({
    try: call,
    catch: (cause) =>
      cause instanceof StoreError ? cause : new StoreError(code, message, { cause }),
  });

/** Parses a driver representation, preserving existing corruption and validation codes. */
const storeDecode = <A>(message: string, decode: () => A) =>
  Effect.try({
    try: decode,
    catch: (cause) =>
      cause instanceof StoreError ? cause : new StoreError('CORRUPT_DATA', message, { cause }),
  });

/** Attaches cleanup evidence to the original Cause; successful work exposes failed cleanup. */
const finishStoreCleanup = <A, E>(
  primary: Exit.Exit<A, E>,
  cleanup: Exit.Exit<unknown, StoreError>,
) => {
  if (Exit.isSuccess(cleanup)) return primary;

  if (Exit.isSuccess(primary)) return Effect.failCause(cleanup.cause);

  const previous = Context.getOrUndefined(Cause.annotations(primary.cause), StoreCleanup);
  const combined = previous === undefined ? cleanup.cause : Cause.combine(previous, cleanup.cause);

  // Effect preserves existing annotation keys by default; explicitly publish the merged receipt.
  return Effect.failCause(
    Cause.annotate(primary.cause, Context.make(StoreCleanup, combined), { overwrite: true }),
  );
};

export { StoreCleanup, storeCall, storeDecode, finishStoreCleanup };
