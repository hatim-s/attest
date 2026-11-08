import type { ProjectCatalog } from '@attest/core';
import * as Effect from 'effect/Effect';
import type { ProjectOverviewEntry } from '../contract/overview.js';
import { toErrorEnvelope } from './error-response.js';

/** Bounds how many project stores one directory request opens at once. */
const OVERVIEW_CONCURRENCY = 4;

/**
 * Reads every catalog project's overview in catalog order. A project whose store fails to open
 * or read becomes an error entry with its API error code, so one unreadable store does not hide
 * the rest of the directory. Defects still fail the request.
 */
const readOverviews = (catalog: ProjectCatalog) =>
  Effect.gen(function* () {
    const projects = yield* catalog.listProjects();

    return yield* Effect.forEach(
      projects,
      (project) =>
        catalog.openProject(project.key).pipe(
          Effect.flatMap((source) => source.getProjectOverview()),
          Effect.map((overview): ProjectOverviewEntry => ({ status: 'ready', project, overview })),
          Effect.catch((error) => {
            const { code, message } = toErrorEnvelope(error).error;

            return Effect.succeed<ProjectOverviewEntry>({
              status: 'error',
              project,
              error: { code, message },
            });
          }),
        ),
      { concurrency: OVERVIEW_CONCURRENCY },
    );
  });

export { readOverviews };
