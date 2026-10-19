import { basename, dirname } from 'node:path';

import type { ProjectRecord } from '@attest/core';

import { slugProjectName } from './project-key.js';
import { readProjectIdentity } from './read-project-identity.js';

/**
 * Describes the project that owns one run store, for hosts that serve a single store. A store
 * at `<root>/.attest/runs.db` belongs to `<root>`; any other store belongs to its directory.
 * The manifest supplies the name and id when the root has one, else the directory name is used.
 */
const describeStoreProject = async (storePath: string): Promise<ProjectRecord> => {
  const storeDirectory = dirname(storePath);
  const root = basename(storeDirectory) === '.attest' ? dirname(storeDirectory) : storeDirectory;
  const identity = await readProjectIdentity(root);
  const name = identity?.name ?? basename(root);

  return { key: slugProjectName(name), name, root, projectId: identity?.projectId };
};

export { describeStoreProject };
