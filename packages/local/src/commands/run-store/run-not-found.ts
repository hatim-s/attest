import * as Effect from 'effect/Effect';
import { StoreError } from '@attest/core';

import type { LocalError } from '../../errors/index.js';

/**
 * Runs one store read and swaps the store's RUN_NOT_FOUND for the caller's not-found error, so
 * commands report a missing run as `resource_not_found` instead of a store failure.
 */
const withRunNotFound = <T, R>(
  read: () => Effect.Effect<T, StoreError | LocalError, R>,
  notFound: (error: StoreError) => LocalError,
) =>
  Effect.suspend(read).pipe(
    Effect.mapError((error) =>
      error instanceof StoreError && error.code === 'RUN_NOT_FOUND' ? notFound(error) : error,
    ),
  );

export { withRunNotFound };
