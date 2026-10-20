import { createBundle, StoreError, type RunStore } from '@attest/core';

import { withReadonlyRunStore } from '../commands/run-store/readonly-run-store.js';
import { LocalError } from '../errors/local-error.js';
import { discoverProject } from '../project/discover-project.js';
import { readCloudLink, resolveCloudProject, type CloudProjectOptions } from './link.js';
import { projectTokenIdentitySchema, uploadedRunResponseSchema } from './protocol.js';

/** Uses the store's stable newest-first paging, skipping unfinished runs across pages. */
const newestFinishedRun = async (store: RunStore): Promise<string> => {
  let cursor: string | undefined;

  do {
    const page = await store.listRuns({ cursor });
    const run = page.items.find((item) => item.status !== 'running');

    if (run !== undefined) return run.id;
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  throw new LocalError('resource_not_found', 'This project has no finished runs to upload.');
};

/** Resolves CI token identity without making session commands accept an unlinked project. */
const resolveCloudUploadProject = async (options: CloudProjectOptions) => {
  if (options.client.credentialSource !== 'project_token') {
    const { root, projectId } = await resolveCloudProject(options);

    return { client: options.client, signal: options.signal, root, projectId };
  }

  const { root } = await discoverProject(options);
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

  const snapshot = await withReadonlyRunStore(root, async (store) => {
    const runId = options.runId ?? (await newestFinishedRun(store));

    try {
      const aggregate = await store.getRunWithCases(runId);
      const bundle = `${createBundle(aggregate.run, aggregate.cases).lines.join('\n')}\n`;

      return { runId, bundle };
    } catch (error) {
      if (error instanceof StoreError && error.code === 'RUN_NOT_FOUND') {
        throw new LocalError('resource_not_found', `Run ${runId} was not found.`);
      }

      throw error;
    }
  });

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
