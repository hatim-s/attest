import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runViewCommand } from './run-view-command.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe('runViewCommand', () => {
  it('reports readiness and closes gracefully when aborted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'attest-view-command-'));
    directories.push(directory);
    const abortController = new AbortController();
    const openedUrls: string[] = [];

    const server = await runViewCommand({
      workingDirectory: directory,
      signal: abortController.signal,
      opener: (url) => {
        openedUrls.push(url);
        return Promise.resolve(true);
      },
      onReady: async ({ origin }) => {
        const response = await fetch(`${origin}/api/v1/health`);
        expect(response.status).toBe(200);
        abortController.abort();
      },
    });

    expect(openedUrls).toHaveLength(1);
    expect(openedUrls[0]).toContain('#token=');
    await expect(server.closed).resolves.toBeUndefined();
  });
});
