import type { ProjectRecord } from '../records/project-schemas.js';
import { StoreError } from './store-error.js';
import type { ProjectCatalog, RunSource } from './types.js';

/** The catalog for hosts that serve one store: a static report or `attest view` inside a project. */
const createSingleProjectCatalog = (project: ProjectRecord, source: RunSource): ProjectCatalog => ({
  listProjects: () => Promise.resolve([project]),
  openProject: (key) =>
    key === project.key
      ? Promise.resolve(source)
      : Promise.reject(new StoreError('PROJECT_NOT_FOUND', `Project ${key} is not served here.`)),
});

export { createSingleProjectCatalog };
