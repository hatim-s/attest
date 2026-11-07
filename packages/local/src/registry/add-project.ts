import * as Effect from 'effect/Effect';
import { resolve } from 'node:path';
import { readProjectIdentity } from '../project/read-project-identity.js';
import { registerProject } from './project-registry.js';

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
const addProject = Effect.fn('addProject')(function* (options: AddProjectOptions) {
  const root = resolve(options.workingDirectory, options.directory);
  const identity = yield* readProjectIdentity(root);

  return yield* registerProject({
    registryPath: options.registryPath,
    root,
    name: options.name ?? identity?.name,
    projectId: identity?.projectId,
  });
});

export { addProject };
