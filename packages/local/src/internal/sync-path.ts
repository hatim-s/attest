import { open } from 'node:fs/promises';

/**
 * Fsyncs a file or directory. Directories need their own fsync after a create, rename, or unlink,
 * or the entry change can be lost on power failure even when the file data is durable.
 */
const syncPath = async (path: string): Promise<void> => {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

export { syncPath };
