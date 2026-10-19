import { lstat, mkdir } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';

import { errnoCode } from './errno-code.js';

/** Walks every ancestor of `path`, optionally creating missing ones with mode 0700. */
const walkAncestors = async (path: string, create: boolean): Promise<void> => {
  const directory = dirname(resolve(path));
  const root = parse(directory).root;
  let current = root;

  for (const component of directory.slice(root.length).split('/')) {
    current = join(current, component);

    if (create)
      await mkdir(current, { mode: 0o700 }).catch((cause: unknown) => {
        if (errnoCode(cause) !== 'EEXIST') throw cause;
      });
    const metadata = await lstat(current);

    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error(`Unsafe private file ancestor: ${current}`);
  }
};

/**
 * Rejects a private file path whose ancestors include a symlink or a non-directory, so a
 * substituted link cannot redirect credentials or the project registry. A missing ancestor
 * rejects with the ENOENT error from lstat.
 */
const assertPrivateAncestors = (path: string): Promise<void> => walkAncestors(path, false);

/** Creates missing ancestors of a private file with mode 0700, then applies the same checks. */
const createPrivateAncestors = (path: string): Promise<void> => walkAncestors(path, true);

export { assertPrivateAncestors, createPrivateAncestors };
