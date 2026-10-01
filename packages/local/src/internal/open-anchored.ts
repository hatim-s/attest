import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';

import { isProjectPath } from '../project/project-path.js';

type AnchoredEntry = {
  handle: FileHandle;
  identity: BigIntStats;
  /** The realpath of the opened entry. */
  path: string;
};

type OpenAnchoredOptions = {
  kind: 'directory' | 'file';
  /** Resolved directory the entry must stay inside. */
  root: string;
};

/**
 * Opens an entry without following a final symlink, then proves the descriptor is the same
 * inode the path names now and that the path resolves inside `root`. Reading through the
 * returned handle means a later path swap cannot redirect the read. Closes the handle and
 * throws a plain Error when any check fails; callers wrap it in their own typed error.
 */
const openAnchored = async (path: string, options: OpenAnchoredOptions): Promise<AnchoredEntry> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const [identity, pathIdentity, resolvedPath] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
      realpath(path),
    ]);
    const kindMatches = options.kind === 'file' ? identity.isFile() : identity.isDirectory();
    if (
      !kindMatches ||
      pathIdentity.isSymbolicLink() ||
      identity.dev !== pathIdentity.dev ||
      identity.ino !== pathIdentity.ino ||
      !isProjectPath(options.root, resolvedPath)
    ) {
      throw new Error(`The ${options.kind} changed identity or left its root while opening.`);
    }
    return { handle, identity, path: resolvedPath };
  } catch (error: unknown) {
    await handle.close().catch(() => undefined);
    throw error;
  }
};

export { openAnchored, type AnchoredEntry };
