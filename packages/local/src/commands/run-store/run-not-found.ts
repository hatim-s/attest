import { StoreError } from '@attest/core';

import type { LocalError } from '../../errors/index.js';

/**
 * Runs one store read and swaps the store's RUN_NOT_FOUND for the caller's not-found error, so
 * commands report a missing run as `resource_not_found` instead of a store failure.
 */
const withRunNotFound = async <T>(
  read: () => Promise<T>,
  notFound: (error: StoreError) => LocalError,
): Promise<T> => {
  try {
    return await read();
  } catch (error: unknown) {
    if (error instanceof StoreError && error.code === 'RUN_NOT_FOUND') throw notFound(error);
    throw error;
  }
};

export { withRunNotFound };
