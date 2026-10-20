import { Writable } from 'node:stream';

import { StoreError, type RunStore } from '@attest/core';

import { withReadonlyRunStore } from '../commands/run-store/readonly-run-store.js';
import { LocalError } from '../errors/local-error.js';
import { exportRunBundle } from '../store/bundle-io.js';
import { resolveCloudProject, type CloudProjectOptions } from './link.js';
import { uploadedRunResponseSchema } from './protocol.js';

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

/** Exports a read-only snapshot so uploading never migrates or modifies the project store. */
const uploadCloudRun = async (options: CloudProjectOptions & { runId?: string }) => {
  const { root, projectId } = await resolveCloudProject(options);
  let selectedRunId: string | undefined;

  const bundle = await withReadonlyRunStore(root, async (store) => {
    selectedRunId = options.runId ?? (await newestFinishedRun(store));
    const chunks: Buffer[] = [];

    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    });

    try {
      await exportRunBundle(store, selectedRunId, destination);
    } catch (error) {
      if (error instanceof StoreError && error.code === 'RUN_NOT_FOUND') {
        throw new LocalError('resource_not_found', `Run ${selectedRunId} was not found.`);
      }

      throw error;
    }

    return Buffer.concat(chunks).toString('utf8');
  });

  if (bundle === undefined)
    throw new LocalError('resource_not_found', 'This project has no local run store.');

  const response = await options.client.upload(
    `/v1/projects/${encodeURIComponent(projectId)}/runs/upload`,
    {
      body: bundle,
      schema: uploadedRunResponseSchema,
      signal: options.signal,
    },
  );

  if (response.run.project_id !== projectId || response.run.id !== selectedRunId) {
    throw new LocalError('cloud_request_failed', 'Cloud returned a different project or run.');
  }

  return { url: response.run.url, unchanged: response.unchanged ?? false };
};

export { uploadCloudRun };
