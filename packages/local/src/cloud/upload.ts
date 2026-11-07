import { valueFromExit } from '../internal/effect-exit.js';
import * as Effect from 'effect/Effect';
import { createBundle, type RunStore } from '@attest/core';

import { withReadonlyRunStore } from '../commands/run-store/readonly-run-store.js';
import { LocalError } from '../errors/local-error.js';
import { discoverProject } from '../project/discover-project.js';
import { readCloudLink, resolveCloudProject, type CloudProjectOptions } from './link.js';
import { projectTokenIdentitySchema, uploadedRunResponseSchema } from './protocol.js';

/** Uses the store's stable newest-first paging, skipping unfinished runs across pages. */
const newestFinishedRun = Effect.fn('newestFinishedRun')(function* (store: RunStore) {
  let cursor: string | undefined;

  do {
    const page = yield* store.listRuns({ cursor });
    const run = page.items.find((item) => item.status !== 'running');

    if (run !== undefined) return run.id;
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  return yield* Effect.fail(
    new LocalError('resource_not_found', 'This project has no finished runs to upload.'),
  );
});

/** Resolves CI token identity without making session commands accept an unlinked project. */
const resolveCloudUploadProject = async (options: CloudProjectOptions) => {
  if (options.client.credentialSource !== 'project_token') {
    const { root, projectId } = await resolveCloudProject(options);

    return { client: options.client, signal: options.signal, root, projectId };
  }

  // EFFECT-BRIDGE(S8c)
  const { root } = await Effect.runPromiseExit(discoverProject(options)).then((exit) =>
    valueFromExit(exit),
  );

  const link = await readCloudLink(root);

  if (link !== undefined && link.base_url !== options.client.baseUrl) {
    throw new LocalError('project_invalid', 'Project link belongs to a different cloud origin.');
  }

  const { token } = await options.client.request('GET', '/v1/token', {
    schema: projectTokenIdentitySchema,
    signal: options.signal,
  });

  if (link !== undefined && link.project_id !== token.project_id) {
    throw new LocalError('project_invalid', 'Project link belongs to a different cloud project.');
  }

  return { client: options.client, signal: options.signal, root, projectId: token.project_id };
};

/** Exports a read-only snapshot so uploading never migrates or modifies the project store. */
const uploadCloudRun = async (
  options: Awaited<ReturnType<typeof resolveCloudUploadProject>> & { runId?: string },
) => {
  const { root, projectId } = options;

  const snapshot = valueFromExit(
    // EFFECT-BRIDGE(S8c)
    await Effect.runPromiseExit(
      withReadonlyRunStore(root, (store) =>
        Effect.gen(function* () {
          const runId = options.runId ?? (yield* newestFinishedRun(store));

          const aggregate = yield* store
            .getRunWithCases(runId)
            .pipe(
              Effect.mapError((error) =>
                error.code === 'RUN_NOT_FOUND'
                  ? new LocalError('resource_not_found', `Run ${runId} was not found.`)
                  : error,
              ),
            );

          const bundle = `${createBundle(aggregate.run, aggregate.cases).lines.join('\n')}\n`;

          return { runId, bundle };
        }),
      ),
    ),
  );

  if (snapshot === undefined)
    throw new LocalError('resource_not_found', 'This project has no local run store.');

  const response = await options.client.upload(
    `/v1/projects/${encodeURIComponent(projectId)}/runs/upload`,
    {
      body: snapshot.bundle,
      schema: uploadedRunResponseSchema,
      signal: options.signal,
    },
  );

  if (response.run.project_id !== projectId || response.run.id !== snapshot.runId) {
    throw new LocalError('cloud_request_failed', 'Cloud returned a different project or run.');
  }

  return { url: response.run.url, unchanged: response.unchanged };
};

export { resolveCloudUploadProject, uploadCloudRun };
