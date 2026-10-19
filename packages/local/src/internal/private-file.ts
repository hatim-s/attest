import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve } from 'node:path';

import { errnoCode } from './errno-code.js';

/** Lists every directory from the filesystem root down to the parent of `path`. */
const ancestorDirectories = (path: string): string[] => {
  const directory = dirname(resolve(path));
  const root = parse(directory).root;
  const directories: string[] = [];
  let current = root;

  for (const component of directory.slice(root.length).split('/')) {
    current = join(current, component);
    directories.push(current);
  }

  return directories;
};

/** `lstat` reports a symlink as a link, never as a directory, so this also rejects symlinks. */
const assertDirectory = async (path: string): Promise<void> => {
  if (!(await lstat(path)).isDirectory()) throw new Error(`Unsafe private file ancestor: ${path}`);
};

/**
 * Rejects a private file path whose ancestors include a symlink or a non-directory, so a
 * substituted link cannot redirect credentials or the project registry. A missing ancestor
 * rejects with the ENOENT error from lstat.
 */
const assertPrivateAncestors = async (path: string): Promise<void> => {
  for (const directory of ancestorDirectories(path)) await assertDirectory(directory);
};

/** Creates missing ancestors of a private file with mode 0700, then applies the same checks. */
const createPrivateAncestors = async (path: string): Promise<void> => {
  for (const directory of ancestorDirectories(path)) {
    await mkdir(directory, { mode: 0o700 }).catch((cause: unknown) => {
      if (errnoCode(cause) !== 'EEXIST') throw cause;
    });
    await assertDirectory(directory);
  }
};

/**
 * Reads a private file without following a substituted symlink at the file or any ancestor.
 * The file must be a regular file that only its owner can read or write. A missing file
 * rejects with the ENOENT error from the filesystem.
 */
const readPrivateFile = async (path: string): Promise<string> => {
  await assertPrivateAncestors(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    const metadata = await handle.stat();

    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0)
      throw new Error(`Unsafe private file: ${path}`);

    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
};

/**
 * Replaces a private file atomically: the text goes to a 0600 temporary file beside it, which
 * is synced and renamed over the target. The directory is 0700 and ancestors are checked again
 * before the rename.
 */
const writePrivateFile = async (path: string, text: string): Promise<void> => {
  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}-${randomUUID()}.tmp`);

  try {
    await createPrivateAncestors(path);
    await chmod(directory, 0o700);
    const handle = await open(temporary, 'wx', 0o600);

    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await assertPrivateAncestors(path);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};

export { assertPrivateAncestors, createPrivateAncestors, readPrivateFile, writePrivateFile };
