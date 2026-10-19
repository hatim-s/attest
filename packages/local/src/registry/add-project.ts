import { resolve } from 'node:path';

import { readProjectIdentity } from '../project/read-project-identity.js';
import { registerProject, type RegistryEntry } from './project-registry.js';

type AddProjectOptions = {
  registryPath: string;
  directory: string;
  workingDirectory: string;
  name?: string;
};

/**
 * Registers a directory for `attest projects add`. The manifest supplies the name and project id
 * when there is one; `name` overrides the manifest name, and a directory without a manifest is
 * named after its basename.
 */
const addProject = async (options: AddProjectOptions): Promise<RegistryEntry> => {
  const root = resolve(options.workingDirectory, options.directory);
  const identity = await readProjectIdentity(root);

  return registerProject({
    registryPath: options.registryPath,
    root,
    name: options.name ?? identity?.name,
    projectId: identity?.projectId,
  });
};

export { addProject, type AddProjectOptions };
