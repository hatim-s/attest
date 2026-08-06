import { StoreError, type StoreErrorCode } from '../types.js';

/** Normalizes driver failures while preserving deliberate store-domain errors and their causes. */
const executeStoreOperation = async <Result>(
  code: StoreErrorCode,
  message: string,
  operation: () => Promise<Result>,
): Promise<Result> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof StoreError) {
      throw error;
    }

    throw new StoreError(code, message, { cause: error });
  }
};

export { executeStoreOperation };
