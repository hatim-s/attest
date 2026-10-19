import { projectManifestSchema } from '@attest/contracts';

import { PROJECT_MANIFEST_FILE } from './discover-project.js';
import { ProjectLoadError } from './project-errors.js';
import { loadJsonResource } from './project-loader/source-loader.js';

type ProjectIdentity = { name: string; projectId: string };

/**
 * Reads only the manifest's display name and id, for callers that list a project rather than
 * load it. Returns undefined when `root` has no manifest; an invalid manifest still throws.
 */
const readProjectIdentity = async (root: string): Promise<ProjectIdentity | undefined> => {
  const manifest = await loadJsonResource(
    root,
    PROJECT_MANIFEST_FILE,
    undefined,
    projectManifestSchema,
  );

  if (manifest.value !== undefined) {
    return { name: manifest.value.name, projectId: manifest.value.project_id };
  }

  if (manifest.diagnostics.every(({ code }) => code === 'source_missing')) return undefined;

  throw new ProjectLoadError(
    'project_invalid',
    `Project manifest validation failed with ${manifest.diagnostics.length} diagnostic(s).`,
    manifest.diagnostics,
  );
};

export { readProjectIdentity };
