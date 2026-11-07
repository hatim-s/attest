import { Effect } from 'effect';
import { withCleanup } from '../runner/lifetime.js';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { join } from 'node:path';

// A walk this large is a repository checkout, not an agent's output; fail instead of hashing it.
const MAX_LISTED_FILES = 10_000;

// Dependency and VCS trees are never the artifacts an eval wants and dwarf everything else.
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules']);

/**
 * Lists regular files under `root` as sorted forward-slash paths relative to it. Symlinks are
 * skipped, so a link cannot pull a file from outside the root into the artifact set.
 */
const listFiles = (root: string) =>
  Effect.gen(function* () {
    const files: string[] = [];
    const pending = [''];

    for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
      const entries = yield* Effect.tryPromise({
        try: () => readdir(join(root, directory), { withFileTypes: true }),
        catch: (cause) => new Error('Workspace listing failed.', { cause }),
      });

      for (const entry of entries) {
        const path = directory === '' ? entry.name : `${directory}/${entry.name}`;

        if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) pending.push(path);

        if (!entry.isFile()) continue;
        files.push(path);

        if (files.length > MAX_LISTED_FILES) {
          return yield* Effect.fail(
            new Error(`${root} holds more than ${String(MAX_LISTED_FILES)} files.`),
          );
        }
      }
    }

    return files.sort();
  });

/** Hashes every listed file with SHA-256, streaming so large files are not held in memory. */
const hashFiles = (root: string) =>
  Effect.gen(function* () {
    const hashes = new Map<string, string>();

    for (const path of yield* listFiles(root)) {
      const hash = createHash('sha256');
      const stream = createReadStream(join(root, path));

      stream.on('data', (chunk) => hash.update(chunk));
      yield* withCleanup(
        Effect.tryPromise({
          try: () => finished(stream),
          catch: (cause) => new Error('Workspace hashing failed.', { cause }),
        }),
        Effect.sync(() => {
          stream.destroy();
        }),
        3_000,
      );
      hashes.set(path, hash.digest('hex'));
    }

    return hashes;
  });

export { hashFiles, listFiles };
