import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  prepareWorkerDirectory,
  resolveHookArgv,
  resolveWorkerDirectory,
} from '../eval-lifecycle.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('eval lifecycle worker directories', () => {
  test('anchors explicit hook script arguments to the project root', () => {
    expect(resolveHookArgv('/project', ['node', './hooks/setup.mjs', 'before_case'])).toEqual([
      'node',
      '/project/hooks/setup.mjs',
      'before_case',
    ]);
  });

  test('keeps the default runtime working directory when workers are not configured', () => {
    expect(resolveWorkerDirectory('/project', 'run-1', 0, undefined)).toBeUndefined();
  });

  test('rejects an explicit worker directory equal to the project root', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'attest-worker-root-'));
    temporaryDirectories.push(projectRoot);
    expect(() =>
      resolveWorkerDirectory(projectRoot, 'run-1', 0, {
        workers: { count: 1, directory: '.' },
      }),
    ).toThrow('Eval worker directory escapes the project');
    await expect(prepareWorkerDirectory(projectRoot, projectRoot)).rejects.toThrow(
      'Eval worker directory escapes the project through a symbolic link.',
    );
  });

  test('rejects worker paths that traverse a symlink outside the project', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'attest-workers-'));
    temporaryDirectories.push(parent);
    const projectRoot = join(parent, 'project');
    const outside = join(parent, 'outside');
    await Promise.all([mkdir(projectRoot), mkdir(outside)]);
    await symlink(outside, join(projectRoot, 'linked'));

    await expect(
      prepareWorkerDirectory(projectRoot, join(projectRoot, 'linked', 'worker-0')),
    ).rejects.toThrow('Eval worker directory escapes the project through a symbolic link.');
  });

  test('requires distinct templates when multiple workers are configured', () => {
    expect(() =>
      resolveWorkerDirectory('/project', 'run-1', 0, {
        workers: { count: 2, directory: '.attest/workers/{run_id}' },
      }),
    ).toThrow('Eval worker directory must include {worker_index} when worker count exceeds one.');
  });
});
