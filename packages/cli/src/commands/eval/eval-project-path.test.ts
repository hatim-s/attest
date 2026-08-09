import { access, lstat, mkdir, mkdtemp, readdir, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore } from '@attest/core';
import { afterEach, describe, expect, it } from 'vitest';

import { openEvalProjectStore } from './eval-project-path.js';

const directories: string[] = [];

/** Creates and tracks one isolated directory for the store-boundary regression fixtures. */
const createTemporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('openEvalProjectStore', () => {
  it('rejects a parent swap in the validation-to-open window without outside writes', async () => {
    const projectRoot = await createTemporaryDirectory('attest-store-boundary-');
    const outside = await createTemporaryDirectory('attest-store-outside-');
    const originalDirectory = join(projectRoot, '.attest-original');

    await expect(
      openEvalProjectStore(projectRoot, {
        beforeCapture: async () => {
          await rename(join(projectRoot, '.attest'), originalDirectory);
          await symlink(outside, join(projectRoot, '.attest'));
        },
      }),
    ).rejects.toMatchObject({ code: 'run_failed', path: '.attest/runs.db' });

    expect(await readdir(outside)).toEqual([]);
    await expect(access(join(outside, 'runs.db'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves final SQLite file symlink rejection', async () => {
    const projectRoot = await createTemporaryDirectory('attest-store-boundary-');
    const outside = await createTemporaryDirectory('attest-store-outside-');
    await mkdir(join(projectRoot, '.attest'));
    await symlink(join(outside, 'runs.db'), join(projectRoot, '.attest', 'runs.db'));

    await expect(openEvalProjectStore(projectRoot)).rejects.toMatchObject({
      code: 'run_failed',
      path: '.attest/runs.db',
    });
    expect(await readdir(outside)).toEqual([]);
  });

  it('restores the canonical directory around an opened compatible SQLite store', async () => {
    const projectRoot = await createTemporaryDirectory('attest-store-boundary-');
    const store = await openEvalProjectStore(projectRoot);
    let runId: string;
    try {
      const run = await store.runs.createRun({
        configHash: 'sha256:boundary',
        configJson: '{}',
        configVersion: 'attest.eval-run/v2',
      });
      runId = run.id;
      await store.runs.finalizeRun(run.id, 'completed');
      await expect(store.runs.getRun(run.id)).resolves.toMatchObject({ status: 'completed' });
    } finally {
      await store.close();
    }

    expect((await lstat(join(projectRoot, '.attest'))).isSymbolicLink()).toBe(false);
    expect((await lstat(join(projectRoot, '.attest', 'runs.db'))).isFile()).toBe(true);
    expect((await readdir(projectRoot)).filter((entry) => entry.endsWith('.opening'))).toEqual([]);

    const reopened = await openStore(join(projectRoot, '.attest', 'runs.db'));
    try {
      await expect(reopened.runs.getRun(runId)).resolves.toMatchObject({ status: 'completed' });
    } finally {
      await reopened.close();
    }
  });
});
