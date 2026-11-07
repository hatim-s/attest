import { parseWithSchemaSync } from '@attest/contracts';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import { Kysely } from 'kysely';

import { projectListSchema } from '@attest/api/contract';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runViewCommand } from '../run-view-command.js';

const directories: string[] = [];

const temporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), prefix));
  directories.push(directory);

  return directory;
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe('runViewCommand', () => {
  it('serves the working directory as one project and closes gracefully when aborted', async () => {
    const directory = await temporaryDirectory('attest-view-command-');
    const abortController = new AbortController();

    const server = await runViewCommand({
      scope: { kind: 'store' },
      workingDirectory: directory,
      signal: abortController.signal,
      onReady: async ({ origin }) => {
        const projects = parseWithSchemaSync(
          projectListSchema,
          await fetch(`${origin}/api/projects`).then((response) => response.json()),
        );

        expect(projects.items).toHaveLength(1);

        const [runsResponse, dashboardResponse] = await Promise.all([
          fetch(`${origin}/api/projects/${projects.items[0]?.key ?? ''}/runs`),
          fetch(origin),
        ]);

        expect(runsResponse.status).toBe(200);
        expect(await dashboardResponse.text()).toContain('<div id="root"></div>');
        abortController.abort();
      },
    });

    await expect(server.closed).resolves.toBeUndefined();
  });

  it.each([
    [undefined, true],
    ['.attest/runs.db', true],
    ['elsewhere/runs.db', false],
  ])('with --store %s, offers run control: %s', async (storePath, control) => {
    const directory = await temporaryDirectory('attest-view-control-');
    const abortController = new AbortController();
    let dashboard = '';

    await runViewCommand({
      scope: { kind: 'store', storePath },
      workingDirectory: directory,
      signal: abortController.signal,
      onReady: async ({ origin }) => {
        dashboard = await fetch(origin).then((response) => response.text());
        abortController.abort();
      },
    });

    // Runs the CLI starts are recorded in `.attest/runs.db`, so only that store can show them.
    expect(/"capabilities":\{"control":(true|false)\}/.exec(dashboard)?.[1]).toBe(String(control));
  });

  it('rejects a malformed registry before the server starts', async () => {
    const home = await temporaryDirectory('attest-view-home-');
    const registryPath = join(home, 'projects.json');
    await writeFile(registryPath, '{', { mode: 0o600 });
    const abortController = new AbortController();
    let started = false;

    await expect(
      runViewCommand({
        scope: { kind: 'registry', registryPath },
        workingDirectory: home,
        signal: abortController.signal,
        onReady: () => {
          started = true;
          abortController.abort();
        },
      }),
    ).rejects.toMatchObject({ code: 'registry_invalid' });
    expect(started).toBe(false);
  });
  it('closes the listener and preserves an onReady failure', async () => {
    const directory = await temporaryDirectory('attest-view-onready-');
    const primary = new Error('onReady failed');
    let origin = '';
    await expect(
      runViewCommand({
        scope: { kind: 'store' },
        workingDirectory: directory,
        onReady: (server) => {
          origin = server.origin;
          throw primary;
        },
      }),
    ).rejects.toBe(primary);
    await expect(fetch(origin)).rejects.toThrow();
  });

  it('preserves a listen failure and its store release diagnostic', async () => {
    const directory = await temporaryDirectory('attest-view-listen-');
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    // SAFETY: A completed TCP listen on a loopback host returns AddressInfo, never a pipe path.
    const address = blocker.address() as AddressInfo;
    const acknowledgement = new Error('store close acknowledgement lost');

    // Close the real database, then simulate the driver losing its release acknowledgement.
    const release = vi.spyOn(Kysely.prototype, 'destroy').mockImplementationOnce(async function (
      this: Kysely<unknown>,
    ) {
      release.mockRestore();
      await this.destroy();
      throw acknowledgement;
    });

    try {
      await expect(
        runViewCommand({
          scope: { kind: 'store' },
          workingDirectory: directory,
          port: address.port,
        }),
      ).rejects.toMatchObject({
        code: 'EADDRINUSE',
        cleanupFailure: {
          code: 'WRITE_FAILED',
          message: 'Store work completed but release failed.',
        },
      });
    } finally {
      release.mockRestore();
      await new Promise<void>((resolve, reject) =>
        blocker.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });
});
