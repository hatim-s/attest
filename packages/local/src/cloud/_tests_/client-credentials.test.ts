import * as Exit from 'effect/Exit';
import * as Cause from 'effect/Cause';
import { valueFromExit } from '../../internal/effect-exit.js';
import * as Effect from 'effect/Effect';
import { stripStruct } from '@attest/contracts';
import { parseWithSchemaSync } from '@attest/contracts';
import * as Schema from 'effect/Schema';
import { syncBuiltinESMExports } from 'node:module';
import { mock as nodeMock } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { mkdtemp, rm, stat, symlink, chmod, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCloudClient } from '../client.js';
import { emptyResponseSchema } from '../protocol.js';
import { readCloudCredentials, writeCloudCredentials } from '../credentials.js';
import { cloudEvents, loginCloud, logoutCloud } from '../commands.js';

const directories: string[] = [];

afterEach(async () => {
  nodeMock.timers.reset();
  syncBuiltinESMExports();
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

    const client = await Effect.runPromiseExit(
      createCloudClient({
        baseUrl: 'https://cloud.example.test',
        accessToken: 'private-token',
        fetch: fetcher,
      }),
    ).then(valueFromExit);

    await expect(
      Effect.runPromiseExit(
        client.request('GET', '//other.example.test/v1/session', { schema: Schema.Unknown }),
      ).then(valueFromExit),
    ).rejects.toMatchObject({
      code: 'cli_usage',
    });
    await expect(
      Effect.runPromiseExit(
        client.request('GET', '/v1/../../secrets', { schema: Schema.Unknown }),
      ).then(valueFromExit),
    ).rejects.toMatchObject({
      code: 'cli_usage',
    });
    expect(fetcher).not.toHaveBeenCalled();
    await Effect.runPromiseExit(
      client.request('GET', '/v1/session', { schema: Schema.Unknown }),
    ).then(valueFromExit);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      redirect: 'error',
    });
    await expect(
      Effect.runPromiseExit(createCloudClient({ baseUrl: 'http://remote.example.test' })).then(
        valueFromExit,
      ),
    ).rejects.toMatchObject({ code: 'cli_usage' });
  });
  it('sanitizes server errors rather than printing their messages or tokens', async () => {
    const client = await Effect.runPromiseExit(
      createCloudClient({
        baseUrl: 'https://cloud.example.test',
        fetch: vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            Response.json(
              { error: { code: 'quota_exceeded', message: 'private-token and secret data' } },
              { status: 403 },
            ),
          ),
      }),
    ).then(valueFromExit);

    await expect(
      Effect.runPromiseExit(client.request('GET', '/v1/session', { schema: Schema.Unknown })).then(
        valueFromExit,
      ),
    ).rejects.toMatchObject({
      code: 'cloud_request_failed',
      message: 'Cloud request failed (403, quota_exceeded).',
      details: { remote_code: 'quota_exceeded', status: 403 },
    });
  });
  it('wraps invalid successful JSON in the cloud error contract', async () => {
    const client = await Effect.runPromiseExit(
      createCloudClient({
        baseUrl: 'https://cloud.example.test',
        fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('invalid-json')),
      }),
    ).then(valueFromExit);

    await expect(
      Effect.runPromiseExit(client.request('GET', '/v1/session', { schema: Schema.Unknown })).then(
        valueFromExit,
      ),
    ).rejects.toMatchObject({
      code: 'cloud_request_failed',
      message: 'Cloud returned an invalid JSON response.',
    });
  });
  it('writes private atomic credentials and refuses symlink and public reads', async () => {
    const path = await temporaryPath();

    const credentials = {
      baseUrl: 'https://cloud.example.test',
      accessToken: 'private-token',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };

    await Effect.runPromiseExit(writeCloudCredentials(credentials, path)).then(valueFromExit);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await Effect.runPromiseExit(readCloudCredentials(path)).then(valueFromExit)).toEqual(
      credentials,
    );
    const link = `${path}.link`;
    await symlink(path, link);
    await expect(
      Effect.runPromiseExit(readCloudCredentials(link)).then(valueFromExit),
    ).rejects.toMatchObject({ code: 'cloud_auth_required' });
    await chmod(path, 0o644);
    await expect(
      Effect.runPromiseExit(readCloudCredentials(path)).then(valueFromExit),
    ).rejects.toMatchObject({ code: 'cloud_auth_required' });
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

    const result = await Effect.runPromiseExit(
      loginCloud({
        baseUrl: 'https://cloud.example.test',
        credentialPath: path,
        fetch: fetcher,
        onDevice: (notice) => notices.push(notice),
      }),
    ).then(valueFromExit);

    expect(JSON.stringify({ result, notices })).not.toContain('private-');
    expect(
      (await Effect.runPromiseExit(readCloudCredentials(path)).then(valueFromExit)).accessToken,
    ).toBe('private-token');

    const start = parseWithSchemaSync(
      stripStruct({ code_challenge: Schema.String }),
      await new Response(fetcher.mock.calls[0]![1]!.body).json(),
    );

    const token = parseWithSchemaSync(
      stripStruct({ code_verifier: Schema.String }),
      await new Response(fetcher.mock.calls[1]![1]!.body).json(),
    );

    expect(start.code_challenge).not.toBe(token.code_verifier);
  });
  it('polls pending approval and accumulates and retains each five-second slow_down increase', async () => {
    const path = await temporaryPath();

    const responses = [
      Response.json({
        device_code: 'private-device',
        user_code: 'ABCD',
        verification_uri: 'https://cloud.example.test/approve',
        expires_in: 600,
        interval: 3,
      }),
      Response.json({ error: { code: 'authorization_pending' } }, { status: 400 }),
      Response.json({ error: { code: 'slow_down' } }, { status: 400 }),
      Response.json({ error: { code: 'slow_down' } }, { status: 400 }),
      Response.json({ error: { code: 'authorization_pending' } }, { status: 400 }),
      Response.json({ access_token: 'approved-token', token_type: 'Bearer', expires_in: 600 }),
    ];

    const fetcher = vi.fn<typeof fetch>(() => {
      const response = responses.shift();

      if (response === undefined) throw new Error('Unexpected device request.');

      return Promise.resolve(response);
    });

    nodeMock.timers.enable({ apis: ['setTimeout', 'Date'] });
    syncBuiltinESMExports();

    const login = Effect.runPromiseExit(
      loginCloud({
        baseUrl: 'https://cloud.example.test',
        credentialPath: path,
        fetch: fetcher,
        onDevice: () => {},
      }),
    ).then(valueFromExit);

    await setImmediate();
    expect(fetcher).toHaveBeenCalledTimes(2);
    nodeMock.timers.tick(2999);
    await setImmediate();
    expect(fetcher).toHaveBeenCalledTimes(2);
    nodeMock.timers.tick(1);
    await setImmediate();
    expect(fetcher).toHaveBeenCalledTimes(3);
    nodeMock.timers.tick(7999);
    await setImmediate();
    expect(fetcher).toHaveBeenCalledTimes(3);
    nodeMock.timers.tick(1);
    await setImmediate();
    expect(fetcher).toHaveBeenCalledTimes(4);
    nodeMock.timers.tick(12999);
    await setImmediate();
    expect(fetcher).toHaveBeenCalledTimes(4);
    nodeMock.timers.tick(1);
    await setImmediate();
    expect(fetcher).toHaveBeenCalledTimes(5);
    nodeMock.timers.tick(12999);
    await setImmediate();
    expect(fetcher).toHaveBeenCalledTimes(5);
    nodeMock.timers.tick(1);
    await expect(login).resolves.toEqual({
      base_url: 'https://cloud.example.test',
      authenticated: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(
      (await Effect.runPromiseExit(readCloudCredentials(path)).then(valueFromExit)).accessToken,
    ).toBe('approved-token');
  });
  it.each([
    ['expired_token', 'Cloud approval code expired. Run attest cloud login again.'],
    ['access_denied', 'Cloud login was denied. Run attest cloud login again.'],
  ])('ends device login on %s with a login repair', async (code, message) => {
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
      .mockResolvedValueOnce(Response.json({ error: { code } }, { status: 400 }));

    await expect(
      Effect.runPromiseExit(
        loginCloud({
          baseUrl: 'https://cloud.example.test',
          credentialPath: path,
          fetch: fetcher,
          onDevice: () => {},
        }),
      ).then(valueFromExit),
    ).rejects.toMatchObject({ code: 'cloud_auth_required', message });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('distinguishes schema mismatches from invalid JSON', async () => {
    const client = await Effect.runPromiseExit(
      createCloudClient({
        baseUrl: 'https://cloud.example.test',
        fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ wrong: true })),
      }),
    ).then(valueFromExit);

    await expect(
      Effect.runPromiseExit(
        client.request('GET', '/v1/session', { schema: stripStruct({ id: Schema.String }) }),
      ).then(valueFromExit),
    ).rejects.toMatchObject({
      code: 'cloud_request_failed',
      message: 'Cloud returned a response that does not match the protocol.',
    });
  });
  it('clears credentials after logout succeeds with a JSON body', async () => {
    const path = await temporaryPath();
    await Effect.runPromiseExit(
      writeCloudCredentials(
        {
          baseUrl: 'https://cloud.example.test',
          accessToken: 'token',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
        path,
      ),
    ).then(valueFromExit);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true })));
    await expect(Effect.runPromiseExit(logoutCloud(path)).then(valueFromExit)).resolves.toEqual({
      authenticated: false,
    });
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('reconnects with the last event cursor without submitting a second run', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        events: [{ sequence: 8, time: '2026-10-02T00:00:00Z', event: 'progress', data: {} }],
        next_cursor: 8,
      }),
    );

    const client = await Effect.runPromiseExit(
      createCloudClient({ baseUrl: 'https://cloud.example.test', fetch: fetcher }),
    ).then(valueFromExit);

    const page = await Effect.runPromiseExit(
      cloudEvents({ client, projectId: 'p', runId: 'r', after: 7 }),
    ).then(valueFromExit);

    expect(page.next_cursor).toBe(8);
    expect(new Request(fetcher.mock.calls[0]![0]).url).toBe(
      'https://cloud.example.test/v1/projects/p/runs/r/events?after=7',
    );
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe('GET');
  });
  it('revokes and clears an expired stored session', async () => {
    const path = await temporaryPath();
    await Effect.runPromiseExit(
      writeCloudCredentials(
        {
          baseUrl: 'https://cloud.example.test',
          accessToken: 'expired-token',
          expiresAt: new Date(Date.now() - 60000).toISOString(),
        },
        path,
      ),
    ).then(valueFromExit);

    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: { code: 'unauthorized' } }, { status: 401 }));

    vi.stubGlobal('fetch', fetcher);
    expect(await Effect.runPromiseExit(logoutCloud(path)).then(valueFromExit)).toEqual({
      authenticated: false,
    });
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'DELETE',
    });
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      'Bearer expired-token',
    );
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects an ancestor symlink and a response that would regress the event cursor', async () => {
    const path = await temporaryPath();

    const credentials = {
      baseUrl: 'https://cloud.example.test',
      accessToken: 'token',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };

    await Effect.runPromiseExit(writeCloudCredentials(credentials, path)).then(valueFromExit);
    const linkedDirectory = join(dirname(dirname(path)), 'linked');
    await symlink(dirname(path), linkedDirectory);
    await expect(
      Effect.runPromiseExit(readCloudCredentials(join(linkedDirectory, 'credentials.json'))).then(
        valueFromExit,
      ),
    ).rejects.toMatchObject({ code: 'cloud_auth_required' });
    await expect(
      Effect.runPromiseExit(
        writeCloudCredentials(credentials, join(linkedDirectory, 'credentials.json')),
      ).then(valueFromExit),
    ).rejects.toMatchObject({ code: 'cloud_credentials_failed' });

    const client = await Effect.runPromiseExit(
      createCloudClient({
        baseUrl: credentials.baseUrl,
        fetch: vi
          .fn<typeof fetch>()
          .mockResolvedValue(Response.json({ events: [], next_cursor: 2 })),
      }),
    ).then(valueFromExit);

    await expect(
      Effect.runPromiseExit(cloudEvents({ client, projectId: 'p', runId: 'r', after: 7 })).then(
        valueFromExit,
      ),
    ).rejects.toMatchObject({ code: 'cloud_request_failed' });
  });
});

it.each([
  [409, 'run_conflict', 'session-secret'],
  [409, 'run_conflict', 'atp_project-secret'],
  [422, 'run_not_finished', 'session-secret'],
] as const)(
  'preserves upload failure %s as a closed local error',
  async (status, code, accessToken) => {
    const client = await Effect.runPromiseExit(
      createCloudClient({
        baseUrl: 'https://cloud.test',
        accessToken,
        fetch: () =>
          Promise.resolve(
            Response.json(
              { error: { code, message: `Upload rejected for Bearer ${accessToken}.` } },
              { status },
            ),
          ),
      }),
    ).then(valueFromExit);

    await expect(
      Effect.runPromiseExit(
        client.upload('/v1/projects/p/runs/upload', {
          body: 'bundle',
          schema: emptyResponseSchema,
        }),
      ).then(valueFromExit),
    ).rejects.toMatchObject({
      code,
      message: 'Upload rejected for Bearer [REDACTED].',
      details: { status, remote_code: code },
    });
  },
);

it('retains a known error code when its message exceeds the display limit', async () => {
  const client = await Effect.runPromiseExit(
    createCloudClient({
      baseUrl: 'https://cloud.test',
      fetch: () =>
        Promise.resolve(
          Response.json(
            { error: { code: 'run_conflict', message: 'x'.repeat(5000) } },
            { status: 409 },
          ),
        ),
    }),
  ).then(valueFromExit);

  await expect(
    Effect.runPromiseExit(
      client.upload('/v1/projects/p/runs/upload', {
        body: 'bundle',
        schema: emptyResponseSchema,
      }),
    ).then(valueFromExit),
  ).rejects.toMatchObject({ code: 'run_conflict', message: 'x'.repeat(4096) });
});

it('joins an accepted fetch that ignores cancellation without replaying dispatch', async () => {
  let start!: () => void;

  const started = new Promise<void>((resolve) => {
    start = resolve;
  });

  let accept!: (value: Response) => void;

  const response = new Promise<Response>((resolve) => {
    accept = resolve;
  });

  const controller = new AbortController();

  const fetcher = vi.fn<typeof fetch>(() => {
    start();

    return response;
  });

  const client = await Effect.runPromiseExit(
    createCloudClient({ baseUrl: 'https://cloud.test', fetch: fetcher }),
  ).then(valueFromExit);

  let settled = false;

  const pending = Effect.runPromiseExit(
    client.request('POST', '/v1/projects', {
      schema: emptyResponseSchema,
      body: { name: 'fixture' },
      signal: controller.signal,
    }),
  )
    .then(valueFromExit)
    .finally(() => {
      settled = true;
    });

  await started;
  controller.abort();
  await setImmediate();
  expect(settled).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
  accept(Response.json({ ok: true }));
  await expect(pending).resolves.toEqual({ ok: true });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('preserves a caller schema refinement defect through the HTTP boundary', async () => {
  const defect = new Error('Refinement invariant');

  const schema = Schema.String.check(
    Schema.makeFilter(() => {
      throw defect;
    }),
  );

  const client = await Effect.runPromiseExit(
    createCloudClient({
      baseUrl: 'https://cloud.test',
      fetch: () => Promise.resolve(Response.json('fixture')),
    }),
  ).then(valueFromExit);

  const exit = await Effect.runPromiseExit(client.request('GET', '/v1/fixture', { schema }));

  if (Exit.isSuccess(exit)) throw new Error('Expected defect');
  expect(exit.cause.reasons.find(Cause.isDieReason)?.defect).toBe(defect);
});

it('cancels the device polling wait without another token request', async () => {
  const controller = new AbortController();

  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        device_code: 'fixture',
        user_code: 'ABCD',
        verification_uri: 'https://cloud.test/approve',
        expires_in: 600,
        interval: 60,
      }),
    )
    .mockResolvedValueOnce(
      Response.json({ error: { code: 'authorization_pending' } }, { status: 400 }),
    );

  const pending = Effect.runPromiseExit(
    loginCloud({
      baseUrl: 'https://cloud.test',
      credentialPath: await temporaryPath(),
      signal: controller.signal,
      fetch: fetcher,
      onDevice: () => {},
    }),
  ).then(valueFromExit);

  await setImmediate();
  expect(fetcher).toHaveBeenCalledTimes(2);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
