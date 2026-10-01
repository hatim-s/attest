import { mkdtemp, rm, stat, symlink, chmod, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCloudClient } from '../client.js';
import { readCloudCredentials, writeCloudCredentials } from '../credentials.js';
import { cloudEvents, loginCloud, logoutCloud } from '../commands.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const temporaryPath = async (): Promise<string> => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'attest-cloud-'));
  directories.push(root);
  return join(root, 'private', 'credentials.json');
};

describe('cloud trust boundaries', () => {
  it('keeps bearer tokens on the configured origin and rejects redirects', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ email: 'user@example.test' }));
    const client = createCloudClient({
      baseUrl: 'https://cloud.example.test',
      accessToken: 'private-token',
      fetch: fetcher,
    });
    await expect(client.request('GET', '//other.example.test/v1/session')).rejects.toMatchObject({
      code: 'cli_usage',
    });
    await expect(client.request('GET', '/v1/../../secrets')).rejects.toMatchObject({
      code: 'cli_usage',
    });
    expect(fetcher).not.toHaveBeenCalled();
    await client.request('GET', '/v1/session');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      redirect: 'error',
      headers: { authorization: 'Bearer private-token' },
    });
    expect(() => createCloudClient({ baseUrl: 'http://remote.example.test' })).toThrow();
  });

  it('sanitizes server errors rather than printing their messages or tokens', async () => {
    const client = createCloudClient({
      baseUrl: 'https://cloud.example.test',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json(
            { error: { code: 'quota_exceeded', message: 'private-token and secret data' } },
            { status: 403 },
          ),
        ),
    });
    await expect(client.request('GET', '/v1/session')).rejects.toMatchObject({
      code: 'cloud_request_failed',
      message: 'Cloud request failed (403, quota_exceeded).',
      details: { remote_code: 'quota_exceeded', status: 403 },
    });
  });

  it('writes private atomic credentials and refuses symlink and public reads', async () => {
    const path = await temporaryPath();
    const credentials = {
      baseUrl: 'https://cloud.example.test',
      accessToken: 'private-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await writeCloudCredentials(credentials, path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readCloudCredentials(path)).toEqual(credentials);
    const link = `${path}.link`;
    await symlink(path, link);
    await expect(readCloudCredentials(link)).rejects.toMatchObject({ code: 'cloud_auth_required' });
    await chmod(path, 0o644);
    await expect(readCloudCredentials(path)).rejects.toMatchObject({ code: 'cloud_auth_required' });
  });

  it('saves a device token without returning it or exposing the device verifier', async () => {
    const path = await temporaryPath();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          device_code: 'private-device',
          user_code: 'ABCD',
          verification_uri: 'https://cloud.example.test/approve',
          expires_in: 600,
          interval: 3,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ access_token: 'private-token', token_type: 'Bearer', expires_in: 600 }),
      );
    const notices: unknown[] = [];
    const result = await loginCloud({
      baseUrl: 'https://cloud.example.test',
      credentialPath: path,
      fetch: fetcher,
      onDevice: (notice) => notices.push(notice),
    });
    expect(JSON.stringify({ result, notices })).not.toContain('private-');
    expect((await readCloudCredentials(path)).accessToken).toBe('private-token');
    const start = JSON.parse(fetcher.mock.calls[0]![1]!.body as string) as {
      code_challenge: string;
    };
    const token = JSON.parse(fetcher.mock.calls[1]![1]!.body as string) as {
      code_verifier: string;
    };
    expect(start.code_challenge).not.toBe(token.code_verifier);
  });

  it('reconnects with the last event cursor without submitting a second run', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        events: [{ sequence: 8, time: '2026-10-02T00:00:00Z', event: 'progress', data: {} }],
        next_cursor: 8,
      }),
    );
    const client = createCloudClient({ baseUrl: 'https://cloud.example.test', fetch: fetcher });
    const page = await cloudEvents({ client, projectId: 'p', runId: 'r', after: 7 });
    expect(page.next_cursor).toBe(8);
    expect((fetcher.mock.calls[0]?.[0] as URL).href).toBe(
      'https://cloud.example.test/v1/projects/p/runs/r/events?after=7',
    );
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe('GET');
  });
  it('revokes and clears an expired stored session', async () => {
    const path = await temporaryPath();
    await writeCloudCredentials(
      {
        baseUrl: 'https://cloud.example.test',
        accessToken: 'expired-token',
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
      path,
    );
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: { code: 'unauthorized' } }, { status: 401 }));
    vi.stubGlobal('fetch', fetcher);
    expect(await logoutCloud(path)).toEqual({ authenticated: false });
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'DELETE',
      headers: { authorization: 'Bearer expired-token' },
    });
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an ancestor symlink and a response that would regress the event cursor', async () => {
    const path = await temporaryPath();
    const credentials = {
      baseUrl: 'https://cloud.example.test',
      accessToken: 'token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await writeCloudCredentials(credentials, path);
    const linkedDirectory = join(dirname(dirname(path)), 'linked');
    await symlink(dirname(path), linkedDirectory);
    await expect(
      readCloudCredentials(join(linkedDirectory, 'credentials.json')),
    ).rejects.toMatchObject({ code: 'cloud_auth_required' });
    await expect(
      writeCloudCredentials(credentials, join(linkedDirectory, 'credentials.json')),
    ).rejects.toMatchObject({ code: 'cloud_credentials_failed' });
    const client = createCloudClient({
      baseUrl: credentials.baseUrl,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ events: [], next_cursor: 2 })),
    });
    await expect(
      cloudEvents({ client, projectId: 'p', runId: 'r', after: 7 }),
    ).rejects.toMatchObject({ code: 'cloud_request_failed' });
  });
});
