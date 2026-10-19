import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { projectListSchema } from '@attest/api/contract';
import { afterEach, describe, expect, it } from 'vitest';

import { registerProject } from '../../registry/index.js';
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
        const projects = projectListSchema.parse(
          await fetch(`${origin}/api/projects`).then((response) => response.json()),
        );

        expect(projects.items).toHaveLength(1);

        const [runsResponse, dashboardResponse] = await Promise.all([
          fetch(`${origin}/api/projects/${projects.items[0]?.key ?? ''}/runs`),
          fetch(origin),
        ]);

        expect(runsResponse.status).toBe(200);
        await expect(dashboardResponse.text()).resolves.toContain('<div id="root"></div>');
        abortController.abort();
      },
    });

    await expect(server.closed).resolves.toBeUndefined();
  });

  it('serves every registered project without creating a store', async () => {
    const home = await temporaryDirectory('attest-view-home-');
    const project = await temporaryDirectory('attest-view-project-');
    const registryPath = join(home, 'projects.json');
    await registerProject({ registryPath, root: project, name: 'Fresh' });
    const abortController = new AbortController();

    await runViewCommand({
      scope: { kind: 'registry', registryPath },
      workingDirectory: home,
      signal: abortController.signal,
      onReady: async ({ origin }) => {
        const runs = await fetch(`${origin}/api/projects/fresh/runs`);

        expect(await runs.json()).toEqual({ items: [] });
        abortController.abort();
      },
    });

    expect(await readdir(project)).toEqual([]);
  });
});
