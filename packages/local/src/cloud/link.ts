import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';

import { z } from 'zod';

import { LocalError } from '../errors/index.js';
import { errnoCode } from '../internal/errno-code.js';
import { discoverProject, type DiscoverProjectOptions } from '../project/discover-project.js';
import { resolveContainedPath } from '../project/project-path.js';
import { acquireProjectLock, releaseProjectLock } from '../project/transaction/project-lock.js';
import type { CloudClient } from './client.js';

const cloudLinkSchema = z.strictObject({
  schema: z.literal('attest.cloud-link.v1'),
  base_url: z.string().url(),
  project_id: z.string().min(1),
  revision_id: z.string().min(1).optional(),
  file_hashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
});
type CloudLink = z.infer<typeof cloudLinkSchema>;
type CloudProjectOptions = DiscoverProjectOptions & { client: CloudClient };

/** Resolves cloud state without following project-local symlinks. */
const cloudLinkPath = async (root: string, create = false): Promise<string> =>
  resolveContainedPath(root, '.attest/cloud.json', {
    createDirectories: create,
    expect: 'file',
    problem: () => new LocalError('project_invalid', 'Cloud link path is unsafe.'),
  });

/** Reads the origin-bound project link, rejecting malformed state rather than resetting it. */
const readCloudLink = async (root: string): Promise<CloudLink | undefined> => {
  try {
    const raw = await readFile(await cloudLinkPath(root), 'utf8');
    const parsed = cloudLinkSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) throw new Error('Invalid link');
    return parsed.data;
  } catch (error: unknown) {
    if (errnoCode(error) === 'ENOENT') return undefined;
    if (error instanceof LocalError) throw error;
    throw new LocalError('project_invalid', 'Cloud link is unreadable or invalid.', {
      path: '.attest/cloud.json',
      cause: error,
    });
  }
};

/** Atomically saves project identity and the exact last synchronized file hashes. */
const writeCloudLink = async (root: string, link: CloudLink): Promise<void> => {
  const path = await cloudLinkPath(root, true);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(cloudLinkSchema.parse(link), null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await cloudLinkPath(root);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (errnoCode(error) !== 'ENOENT') throw error;
    });
  }
};

/** Resolves a linked project and prevents credentials for another origin from being used. */
const resolveCloudProject = async (options: CloudProjectOptions) => {
  const { root } = await discoverProject(options);
  const link = await readCloudLink(root);
  if (link === undefined) {
    throw new LocalError('cli_missing_input', 'This project is not linked to Attest Cloud.', {
      hint: 'Run attest cloud link <project-id> first.',
    });
  }
  if (link.base_url !== options.client.baseUrl) {
    throw new LocalError('project_invalid', 'Project link belongs to a different cloud origin.', {
      hint: 'Log in to the linked origin or explicitly link this project again.',
    });
  }
  return { root, link, projectId: link.project_id, revisionId: link.revision_id };
};

/** Links an existing cloud project without claiming the local files match a revision. */
const linkCloudProject = async (options: CloudProjectOptions & { projectId: string }) => {
  const { root } = await discoverProject(options);
  const response = z
    .object({ project: z.object({ id: z.string() }) })
    .safeParse(
      await options.client.request('GET', `/v1/projects/${encodeURIComponent(options.projectId)}`),
    );
  if (!response.success || response.data.project.id !== options.projectId) {
    throw new LocalError('cloud_request_failed', 'Cloud returned a different or invalid project.');
  }
  const lock = await acquireProjectLock(root);
  try {
    const current = await readCloudLink(root);
    if (
      current !== undefined &&
      (current.project_id !== options.projectId || current.base_url !== options.client.baseUrl)
    ) {
      throw new LocalError(
        'project_changed',
        'This directory is already linked to another cloud project.',
        {
          hint: 'Use a separate project directory to avoid replacing synchronization history.',
        },
      );
    }
    const link: CloudLink = current ?? {
      schema: 'attest.cloud-link.v1',
      base_url: options.client.baseUrl,
      project_id: options.projectId,
      file_hashes: {},
    };
    await writeCloudLink(root, link);
    return { project_id: link.project_id, revision_id: link.revision_id ?? null };
  } finally {
    await releaseProjectLock(lock);
  }
};

export {
  linkCloudProject,
  readCloudLink,
  resolveCloudProject,
  writeCloudLink,
  type CloudLink,
  type CloudProjectOptions,
};
