import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { PROJECT_SCHEMA_ID, type PortableProjectBundle } from '@attest/contracts';
import { createCloudClient } from '../client.js';

import { readCloudLink, writeCloudLink, type CloudLink } from '../link.js';
import { planPullChanges, pushCloudProject, pullCloudProject } from '../sync.js';

const directories: string[] = [];
const hash = (contents: string) => createHash('sha256').update(contents).digest('hex');
const createDirectory = async () => {
  const root = await mkdtemp(join(tmpdir(), 'attest-cloud-sync-'));
  directories.push(root);
  await mkdir(join(root, 'attest'));
  return root;
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('cloud pull conflict planning', () => {
  it('rejects local edits, deletions and newly occupied remote paths without writing', async () => {
    const root = await createDirectory();
    await writeFile(join(root, 'attest/edited.json'), 'local edit');
    await writeFile(join(root, 'attest/new.json'), 'untracked local');
    await expect(
      planPullChanges(
        root,
        {
          'attest/edited.json': hash('base'),
          'attest/deleted.json': hash('base'),
        },
        {
          'attest/edited.json': 'remote',
          'attest/deleted.json': 'remote',
          'attest/new.json': 'remote',
        },
      ),
    ).rejects.toMatchObject({
      code: 'project_changed',
      details: { conflicts: ['attest/edited.json', 'attest/deleted.json', 'attest/new.json'] },
    });
    expect(await readFile(join(root, 'attest/edited.json'), 'utf8')).toBe('local edit');
  });

  it('plans removals and updates from the synchronized base with the manifest last', async () => {
    const root = await createDirectory();
    await writeFile(join(root, 'attest/old.json'), 'old');
    await writeFile(join(root, 'attest.project.json'), 'manifest');
    const changes = await planPullChanges(
      root,
      {
        'attest/old.json': hash('old'),
        'attest.project.json': hash('manifest'),
      },
      { 'attest.project.json': 'new manifest', 'attest/new.json': 'new' },
    );
    expect(changes).toEqual([
      { path: 'attest/new.json', type: 'write', contents: 'new' },
      { path: 'attest/old.json', type: 'remove' },
      { path: 'attest.project.json', type: 'write', contents: 'new manifest' },
    ]);
  });

  it('allows already identical remote files but rejects symlinks and paths outside authored resources', async () => {
    const root = await createDirectory();
    await writeFile(join(root, 'attest/same.json'), 'same');
    expect(await planPullChanges(root, {}, { 'attest/same.json': 'same' })).toEqual([]);
    await symlink(join(root, 'attest/same.json'), join(root, 'attest/link.json'));
    await expect(planPullChanges(root, {}, { 'attest/link.json': 'remote' })).rejects.toMatchObject(
      { code: 'project_invalid' },
    );
    await expect(planPullChanges(root, {}, { '.env': 'remote' })).rejects.toMatchObject({
      code: 'project_invalid',
    });
  });
});

describe('cloud link state', () => {
  it('round-trips origin-bound revision hashes and rejects malformed state', async () => {
    const root = await createDirectory();
    const link: CloudLink = {
      schema: 'attest.cloud-link.v1',
      base_url: 'https://cloud.example',
      project_id: 'project-1',
      revision_id: 'revision-1',
      file_hashes: { 'attest/test.json': hash('test') },
    };
    await writeCloudLink(root, link);
    expect(await readCloudLink(root)).toEqual(link);
    await writeFile(join(root, '.attest/cloud.json'), '{}');
    await expect(readCloudLink(root)).rejects.toMatchObject({ code: 'project_invalid' });
  });

  it('refuses cloud state beneath a symlink', async () => {
    const root = await createDirectory();
    const outside = await createDirectory();
    await symlink(outside, join(root, '.attest'));
    await expect(readCloudLink(root)).rejects.toMatchObject({ code: 'project_invalid' });
  });
});

describe('cloud revision synchronization', () => {
  it('uploads only referenced files and pulls exact bytes through the project journal', async () => {
    const root = await createDirectory();
    const manifest = {
      schema: PROJECT_SCHEMA_ID,
      project_id: '01ARZ3NDEKTSV4RRFFQ69G5FAB',
      name: 'Original',
      resources: { agents: [], tests: [], datasets: [], metrics: [] },
    };
    await writeFile(join(root, 'attest.project.json'), JSON.stringify(manifest));
    await writeFile(join(root, '.env'), 'SECRET=never-upload');
    await writeFile(join(root, 'attest/unreferenced.json'), 'private-data');
    await writeCloudLink(root, {
      schema: 'attest.cloud-link.v1',
      base_url: 'https://cloud.example',
      project_id: 'project-1',
      file_hashes: {},
    });
    let uploaded: PortableProjectBundle | undefined;
    const client = createCloudClient({
      baseUrl: 'https://cloud.example',
      fetch: (_url, init) => {
        if (init?.method === 'POST') {
          if (typeof init.body !== 'string') throw new Error('Expected JSON request');
          const body = JSON.parse(init.body) as {
            bundle: PortableProjectBundle;
            parent_revision_id: string | null;
          };
          expect(body.parent_revision_id).toBe(uploaded === undefined ? null : 'revision-1');
          uploaded = body.bundle;
          return Promise.resolve(
            Response.json({
              revision: { id: 'revision-1', project_id: 'project-1', created_at: '2026-10-01' },
            }),
          );
        }
        const remote = structuredClone(uploaded!);
        remote.resources.project.name = 'Remote';
        remote.files['attest.project.json'] = JSON.stringify(remote.resources.project, null, 2);
        return Promise.resolve(
          Response.json({
            revision: { id: 'revision-2', project_id: 'project-1', created_at: '2026-10-02' },
            bundle: remote,
          }),
        );
      },
    });
    await expect(pushCloudProject({ workingDirectory: root, client })).rejects.toMatchObject({
      code: 'cli_usage',
    });
    await pushCloudProject({ workingDirectory: root, client, acknowledgeNoSecrets: true });
    expect(Object.keys(uploaded!.files)).toEqual(['attest.project.json']);
    await pushCloudProject({ workingDirectory: root, client });
    await pullCloudProject({ workingDirectory: root, client });
    expect(JSON.parse(await readFile(join(root, 'attest.project.json'), 'utf8'))).toMatchObject({
      name: 'Remote',
    });
    expect(await readFile(join(root, '.env'), 'utf8')).toBe('SECRET=never-upload');
    expect((await readCloudLink(root))?.revision_id).toBe('revision-2');
    await writeFile(join(root, 'attest.project.json'), 'local unsaved edit');
    await expect(pullCloudProject({ workingDirectory: root, client })).rejects.toMatchObject({
      code: 'project_changed',
    });
    expect(await readFile(join(root, 'attest.project.json'), 'utf8')).toBe('local unsaved edit');
  });
});
