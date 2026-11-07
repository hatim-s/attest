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
const resolveCloudUploadProject = Effect.fn('resolveCloudUploadProject')(function* (
  options: CloudProjectOptions,
) {
  if (options.client.credentialSource !== 'project_token') {
    const { root, projectId } = yield* resolveCloudProject(options);

    return { client: options.client, signal: options.signal, root, projectId };
  }

  const { root } = yield* discoverProject(options);
  const link = yield* readCloudLink(root);

  if (link !== undefined && link.base_url !== options.client.baseUrl) {
    return yield* Effect.fail(
      new LocalError('project_invalid', 'Project link belongs to a different cloud origin.'),
    );
  }

  const { token } = yield* options.client.request('GET', '/v1/token', {
    schema: projectTokenIdentitySchema,
    signal: options.signal,
  });

  if (link !== undefined && link.project_id !== token.project_id) {
    return yield* Effect.fail(
      new LocalError('project_invalid', 'Project link belongs to a different cloud project.'),
    );
  }

  return { client: options.client, signal: options.signal, root, projectId: token.project_id };
});

/** Exports a read-only snapshot so uploading never migrates or modifies the project store. */
const uploadCloudRun = Effect.fn('uploadCloudRun')(function* (
  options: Effect.Success<ReturnType<typeof resolveCloudUploadProject>> & {
    runId?: string;
  },
) {
  const { root, projectId } = options;

  const snapshot = yield* withReadonlyRunStore(root, (store) =>
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
  );

  if (snapshot === undefined)
    return yield* Effect.fail(
      new LocalError('resource_not_found', 'This project has no local run store.'),
    );

  const response = yield* options.client.upload(
    `/v1/projects/${encodeURIComponent(projectId)}/runs/upload`,
    {
      body: snapshot.bundle,
      schema: uploadedRunResponseSchema,
      signal: options.signal,
    },
  );

  if (response.run.project_id !== projectId || response.run.id !== snapshot.runId) {
    return yield* Effect.fail(
      new LocalError('cloud_request_failed', 'Cloud returned a different project or run.'),
    );
  }

  return { url: response.run.url, unchanged: response.unchanged };
});

export { resolveCloudUploadProject, uploadCloudRun };
