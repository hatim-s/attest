import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

// A walk this large is a repository checkout, not an agent's output; fail instead of hashing it.
const MAX_LISTED_FILES = 10_000;

// Dependency and VCS trees are never the artifacts an eval wants and dwarf everything else.
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules']);

/**
 * Lists regular files under `root` as sorted forward-slash paths relative to it. Symlinks are
 * skipped, so a link cannot pull a file from outside the root into the artifact set.
 */
const listFiles = async (root: string): Promise<string[]> => {
  const files: string[] = [];
  const pending = [''];

  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    const entries = await readdir(join(root, directory), { withFileTypes: true });

    for (const entry of entries) {
      const path = directory === '' ? entry.name : `${directory}/${entry.name}`;

      if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) pending.push(path);

      if (!entry.isFile()) continue;
      files.push(path);

      if (files.length > MAX_LISTED_FILES) {
        throw new Error(`${root} holds more than ${String(MAX_LISTED_FILES)} files.`);
      }
    }
  }

  return files.sort();
};

/** Hashes every listed file with SHA-256, streaming so large files are not held in memory. */
const hashFiles = async (root: string): Promise<Map<string, string>> => {
  const hashes = new Map<string, string>();

  for (const path of await listFiles(root)) {
    const hash = createHash('sha256');

    // SAFETY: a file stream opened without an encoding yields Buffer chunks.
    for await (const chunk of createReadStream(join(root, path)) as AsyncIterable<Buffer>) {
      hash.update(chunk);
    }

    hashes.set(path, hash.digest('hex'));
  }

  return hashes;
};

export { hashFiles, listFiles };
