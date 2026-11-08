import { AttestError } from '@attest/contracts';
import { StoreError } from '@attest/core';
import * as Cause from 'effect/Cause';

/**
 * Types a failure from code that declares plain `Error` or nothing at all: executor transports,
 * runtime metric pipelines, embedder callbacks and rejected iterators. A coded Attest or store
 * error keeps its identity, so the CLI still renders its code; anything else becomes
 * `Cause.UnknownError` with the original as its cause, which the CLI renders as an unknown
 * internal error.
 */
const classifyForeignFailure = (cause: unknown): AttestError | StoreError | Cause.UnknownError =>
  cause instanceof AttestError || cause instanceof StoreError
    ? cause
    : new Cause.UnknownError(cause);

export { classifyForeignFailure };
