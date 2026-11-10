import * as Effect from 'effect/Effect';
import { basename, dirname } from 'node:path';

import type { ProjectRecord } from '@attest/core';

import { slugProjectName } from './project-key.js';
import { readProjectIdentity } from './read-project-identity.js';

/**
 * Describes the project that owns one run store, for hosts that serve a single store. A store
 * inside `<root>/.attest` belongs to `<root>` regardless of filename; other stores belong
 * to their directory.
 * The manifest supplies the name and id when the root has one, else the directory name is used.
 */
const describeStoreProject = Effect.fn('describeStoreProject')(function* (
  storePath: string,
): Effect.fn.Return<
  ProjectRecord,
  | import('../internal/open-anchored.js').AnchoredCleanupFailure
  | import('../internal/open-anchored.js').AnchoredFileFailure
  | import('./project-errors.js').ProjectLoadError
> {
  const storeDirectory = dirname(storePath);
  const root = basename(storeDirectory) === '.attest' ? dirname(storeDirectory) : storeDirectory;
  const identity = yield* readProjectIdentity(root);
  const name = identity?.name ?? basename(root);

  return { key: slugProjectName(name), name, root, projectId: identity?.projectId };
});

export { describeStoreProject };
