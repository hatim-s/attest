import { createHash } from 'node:crypto';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

type TreeSnapshot = Map<string, string>;

/** Hashes every file and symlink target, and records every directory, below a journey root. */
const snapshotTree = async (root: string): Promise<TreeSnapshot> => {
  const snapshot: TreeSnapshot = new Map();

  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(root, absolutePath).split(sep).join('/');

      if (entry.isSymbolicLink()) {
        snapshot.set(relativePath, `symlink:${await readlink(absolutePath)}`);
      } else if (entry.isDirectory()) {
        snapshot.set(`${relativePath}/`, 'directory');
        await visit(absolutePath);
      } else {
        const hash = createHash('sha256')
          .update(await readFile(absolutePath))
          .digest('hex');

        snapshot.set(relativePath, hash);
      }
    }
  };

  await visit(root);

  return snapshot;
};

export { snapshotTree, type TreeSnapshot };
