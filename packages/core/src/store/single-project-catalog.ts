import * as Effect from 'effect/Effect';
import type { ProjectRecord } from '../records/project-schemas.js';
import { StoreError } from './store-error.js';
import type { ProjectCatalog, RunSource } from './types.js';

/** The catalog for hosts that serve one store: a static report or `attest web` inside a project. */
const createSingleProjectCatalog = (project: ProjectRecord, source: RunSource): ProjectCatalog => ({
  listProjects: () => Effect.succeed([project]),
  openProject: (key) =>
    key === project.key
      ? Effect.succeed(source)
      : Effect.fail(new StoreError('PROJECT_NOT_FOUND', `Project ${key} is not served here.`)),
});

export { createSingleProjectCatalog };
