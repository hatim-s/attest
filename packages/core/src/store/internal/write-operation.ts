import { StoreError } from '../types.js';

/** Preserves actionable store errors while normalizing unexpected persistence failures. */
const executeWrite = async <Result>(
  message: string,
  operation: () => Promise<Result>,
): Promise<Result> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof StoreError) {
      throw error;
    }

    throw new StoreError('WRITE_FAILED', message, { cause: error });
  }
};

export { executeWrite };
