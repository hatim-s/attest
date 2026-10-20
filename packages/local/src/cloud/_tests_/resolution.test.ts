import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { authenticatedCloudClient } from '../commands.js';
import { writeCloudCredentials } from '../credentials.js';
import { resolveCloudProject, writeCloudLink } from '../link.js';

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it('resolves the environment pair ahead of a session and rejects incomplete credentials', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'attest-resolution-'));
  directories.push(root);
  const path = join(root, 'private', 'credentials.json');
  await writeCloudCredentials(
    {
      baseUrl: 'https://session.test',
      accessToken: 'session',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
    path,
  );
  vi.stubEnv('ATTEST_CLOUD_URL', undefined);
  vi.stubEnv('ATTEST_CLOUD_TOKEN', undefined);
  expect((await authenticatedCloudClient(path)).baseUrl).toBe('https://session.test');
  vi.stubEnv('ATTEST_CLOUD_URL', 'https://ci.test');
  await expect(authenticatedCloudClient(path)).rejects.toMatchObject({
    code: 'cloud_credentials_invalid',
  });
  vi.stubEnv('ATTEST_CLOUD_TOKEN', 'atp_ci');
  const client = await authenticatedCloudClient(path);
  expect(client.baseUrl).toBe('https://ci.test');
  expect(client.credentialSource).toBe('environment');
  vi.stubEnv('ATTEST_CLOUD_URL', undefined);
  await expect(authenticatedCloudClient(path)).rejects.toMatchObject({
    code: 'cloud_credentials_invalid',
  });
});

it('gets CI project identity from the token and rejects disagreeing links', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'attest-resolution-'));
  directories.push(root);
  await writeFile(join(root, 'attest.project.json'), '{}');
  vi.stubEnv('ATTEST_CLOUD_URL', 'https://ci.test');
  vi.stubEnv('ATTEST_CLOUD_TOKEN', 'atp_ci');

  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(() =>
      Promise.resolve(Response.json({ token: { id: 't', name: 'ci', project_id: 'p' } })),
    );

  vi.stubGlobal('fetch', fetcher);
  const client = await authenticatedCloudClient(join(root, 'absent'));
  const options = { workingDirectory: root, client };
  expect(await resolveCloudProject(options)).toMatchObject({ projectId: 'p' });
  expect(new Request(fetcher.mock.calls[0]![0]).url).toBe('https://ci.test/v1/token');
  expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('authorization')).toBe(
    'Bearer atp_ci',
  );

  const link = {
    schema: 'attest.cloud-link.v1' as const,
    base_url: 'https://ci.test',
    project_id: 'p',
    file_hashes: {},
  };

  await writeCloudLink(root, link);
  expect(await resolveCloudProject(options)).toMatchObject({ projectId: 'p' });
  await writeCloudLink(root, { ...link, project_id: 'other' });
  await expect(resolveCloudProject(options)).rejects.toMatchObject({
    code: 'project_invalid',
    message: 'Project link belongs to a different cloud project.',
  });
  await writeCloudLink(root, { ...link, base_url: 'https://other.test' });
  await expect(resolveCloudProject(options)).rejects.toMatchObject({
    code: 'project_invalid',
    message: 'Project link belongs to a different cloud origin.',
  });
  await writeCloudLink(root, link);
  const controller = new AbortController();
  controller.abort();
  fetcher.mockImplementation((_url, init) => {
    init?.signal?.throwIfAborted();

    return Promise.resolve(Response.json({ token: { id: 't', name: 'ci', project_id: 'p' } }));
  });
  await expect(
    resolveCloudProject({ ...options, signal: controller.signal }),
  ).rejects.toMatchObject({ code: 'cancelled', message: 'Cloud request did not complete.' });
  vi.stubEnv('ATTEST_CLOUD_URL', undefined);
  vi.stubEnv('ATTEST_CLOUD_TOKEN', undefined);
});
