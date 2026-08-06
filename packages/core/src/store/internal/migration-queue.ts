import { resolve } from 'node:path';

const migrationQueueByPath = new Map<string, Promise<void>>();

/** Prevents two in-process openers from racing through the same database migration boundary. */
const runInMigrationQueue = async <Result>(
  path: string,
  operation: (resolvedPath: string) => Promise<Result>,
): Promise<Result> => {
  const resolvedPath = resolve(path);
  const previous = migrationQueueByPath.get(resolvedPath) ?? Promise.resolve();
  const waitForPrevious = previous.catch(() => undefined);
  let releaseSlot: (() => void) | undefined;
  const slot = new Promise<void>((resolveSlot) => {
    releaseSlot = resolveSlot;
  });
  const current = waitForPrevious.then(() => slot);
  migrationQueueByPath.set(resolvedPath, current);

  await waitForPrevious;
  try {
    return await operation(resolvedPath);
  } finally {
    releaseSlot?.();
    if (migrationQueueByPath.get(resolvedPath) === current) {
      migrationQueueByPath.delete(resolvedPath);
    }
  }
};

export { runInMigrationQueue };
