import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type * as CloudAdapter from '@attest/local/cloud';
import { cliResultSchema } from '@attest/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommand as executeCommand, temporaryDirectory } from './support/cli-test-support.js';

const cloud = {
  pushRun: vi.fn<typeof CloudAdapter.pushCloudRun>().mockResolvedValue({
    url: 'https://cloud.example.test/#/projects/project/runs/run',
    unchanged: false,
  }),
  push: vi.fn<typeof CloudAdapter.pushCloudProject>().mockResolvedValue({
    project_id: 'project',
    revision_id: 'rev',
    file_count: 0,
  }),
  run: vi.fn<typeof CloudAdapter.runCloud>().mockResolvedValue({
    run: {
      id: 'run',
      project_id: 'project',
      revision_id: 'revision',
      status: 'queued',
      created_at: '2026-08-08T10:00:00.000Z',
      started_at: null,
      finished_at: null,
      cancel_requested: false,
      raw_expires_at: null,
      error_code: null,
    },
  }),
};

const services = {
  cloud: {
    authenticatedCloudClient: () =>
      Promise.resolve({
        baseUrl: 'https://cloud.example.test',
        upload: () => Promise.reject(new Error('Unexpected upload.')),
        request: () =>
          Promise.reject(new Error('This command fixture should not send HTTP requests.')),
      }),
    resolveCloudProject: () =>
      Promise.resolve({
        root: process.cwd(),
        projectId: 'project',
        revisionId: 'revision',
        link: {
          schema: 'attest.cloud-link.v1' as const,
          base_url: 'https://cloud.example.test',
          project_id: 'project',
          revision_id: 'revision',
          file_hashes: {},
        },
      }),
    pushCloudRun: cloud.pushRun,
    pushCloudProject: cloud.push,
    runCloud: cloud.run,
  },
};

const runCommand = (...[root, argv, options]: Parameters<typeof executeCommand>) =>
  executeCommand(root, argv, { ...options, services });

beforeEach(() => {
  cloud.pushRun.mockClear();
  cloud.push.mockClear();
  cloud.run.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('cloud command translation', () => {
  it('requires the explicit --no-secrets flag to acknowledge a changed upload', async () => {
    const implicit = await runCommand(process.cwd(), ['cloud', 'push', '--output', 'json']);
    expect(implicit.exitCode).toBe(0);
    expect(cloud.push.mock.calls[0]?.[0]).toMatchObject({ acknowledgeNoSecrets: false });

    const explicit = await runCommand(process.cwd(), [
      'cloud',
      'push',
      '--no-secrets',
      '--output',
      'json',
    ]);

    expect(explicit.exitCode).toBe(0);
    expect(cloud.push.mock.calls[1]?.[0]).toMatchObject({ acknowledgeNoSecrets: true });
  });

  it('uses the eval selection contract, linked revision, and retained retry key', async () => {
    const result = await runCommand(process.cwd(), [
      'cloud',
      'run',
      'test-one',
      '--case',
      'case-one',
      '--tag',
      'fast',
      '--sample',
      '2',
      '--seed',
      'seed',
      '--idempotency-key',
      'retry-key',
      '--output',
      'json',
    ]);

    expect(result.exitCode).toBe(0);
    expect(cloud.run.mock.calls[0]?.[0]).toMatchObject({
      projectId: 'project',
      revisionId: 'revision',
      idempotencyKey: 'retry-key',
      request: {
        command: 'eval.run',
        test_ids: ['test-one'],
        case_ids: ['case-one'],
        tags: ['fast'],
        sample: { count: 2, seed: 'seed' },
      },
    });
    expect(result.output).toHaveLength(1);
    expect(cliResultSchema.parse(JSON.parse(result.output[0]!))).toMatchObject({
      ok: true,
      command: 'cloud.run',
      result: { idempotency_key: 'retry-key', run: { id: 'run' } },
    });
    expect(result.errors).toEqual(['Cloud submission retry key: retry-key']);

    const conflict = await runCommand(process.cwd(), [
      'cloud',
      'run',
      'test-one',
      '--all',
      '--output',
      'json',
    ]);

    expect(conflict.exitCode).toBe(2);
    expect(cloud.run).toHaveBeenCalledTimes(1);
  });

  it('keeps cloud credentials under ATTEST_HOME', async () => {
    const home = await temporaryDirectory('attest-home-');
    vi.stubEnv('ATTEST_HOME', home);
    const credentialPath = join(home, 'cloud', 'credentials.json');
    await mkdir(join(home, 'cloud'), { mode: 0o700 });
    await writeFile(
      credentialPath,
      JSON.stringify({
        baseUrl: 'https://cloud.example.test',
        upload: () => Promise.reject(new Error('Unexpected upload.')),
        accessToken: 'token',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      { mode: 0o600 },
    );
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true })));

    const result = await runCommand(process.cwd(), ['cloud', 'logout', '--output', 'json']);

    expect(result.exitCode).toBe(0);
    await expect(stat(credentialPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

it('prints the uploaded dashboard URL and forwards an explicit run ID', async () => {
  const result = await runCommand(process.cwd(), ['cloud', 'push-run', 'run']);
  expect(result.exitCode).toBe(0);
  expect(result.output).toEqual(['https://cloud.example.test/#/projects/project/runs/run']);
  expect(cloud.pushRun.mock.calls[0]?.[0]).toMatchObject({ runId: 'run' });
});

it.each([['create', '--name', 'ci'], ['list'], ['revoke', 'token-id']])(
  'refuses cloud token %s with environment credentials before HTTP',
  async (...args) => {
    const home = await temporaryDirectory('attest-token-home-');
    vi.stubEnv('ATTEST_HOME', home);
    vi.stubEnv('ATTEST_CLOUD_URL', 'https://cloud.example.test');
    vi.stubEnv('ATTEST_CLOUD_TOKEN', 'atp_ci');
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    const result = await executeCommand(home, ['cloud', 'token', ...args, '--output', 'json']);
    expect(result.exitCode).toBe(4);
    expect(cliResultSchema.parse(JSON.parse(result.output[0]!))).toMatchObject({
      ok: false,
      error: { code: 'token_scope' },
    });
    expect(fetcher).not.toHaveBeenCalled();
  },
);

it('creates, lists and revokes tokens for the linked project without saving the secret', async () => {
  const root = await temporaryDirectory('attest-token-project-');
  const home = await temporaryDirectory('attest-token-home-');
  vi.stubEnv('ATTEST_HOME', home);
  vi.stubEnv('ATTEST_CLOUD_URL', undefined);
  vi.stubEnv('ATTEST_CLOUD_TOKEN', undefined);
  await writeFile(join(root, 'attest.project.json'), '{}');
  await mkdir(join(root, '.attest'));
  await writeFile(
    join(root, '.attest/cloud.json'),
    JSON.stringify({
      schema: 'attest.cloud-link.v1',
      base_url: 'https://cloud.example.test',
      project_id: 'p',
      file_hashes: {},
    }),
  );
  await mkdir(join(home, 'cloud'), { mode: 0o700 });

  const credentials = JSON.stringify({
    baseUrl: 'https://cloud.example.test',
    accessToken: 'session',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });

  await writeFile(join(home, 'cloud/credentials.json'), credentials, { mode: 0o600 });
  const token = { id: 't', name: 'ci', created_at: '2026-10-21T00:00:00Z' };

  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ token, secret: 'atp_print-once' }, { status: 201 }))
    .mockResolvedValueOnce(Response.json({ tokens: [token] }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));

  vi.stubGlobal('fetch', fetcher);

  const created = await executeCommand(root, [
    'cloud',
    'token',
    'create',
    '--name',
    'ci',
    '--output',
    'json',
  ]);

  expect(created.exitCode).toBe(0);
  expect(created.output.join('\n').match(/atp_print-once/gu)).toHaveLength(1);
  expect(await executeCommand(root, ['cloud', 'token', 'list', '--output', 'json'])).toMatchObject({
    exitCode: 0,
  });
  expect(
    await executeCommand(root, ['cloud', 'token', 'revoke', 't', '--output', 'json']),
  ).toMatchObject({ exitCode: 0 });
  expect(
    fetcher.mock.calls.map(([url, init]) => [new URL(new Request(url).url).pathname, init?.method]),
  ).toEqual([
    ['/v1/projects/p/tokens', 'POST'],
    ['/v1/projects/p/tokens', 'GET'],
    ['/v1/projects/p/tokens/t', 'DELETE'],
  ]);
  expect(fetcher.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ name: 'ci' }));
  expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
    'Bearer session',
  );
  expect(await readFile(join(home, 'cloud/credentials.json'), 'utf8')).toBe(credentials);
});
