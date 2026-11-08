import { valueFromExit } from '../../../internal/effect-exit.js';
import * as Effect from 'effect/Effect';
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
  test('anchors explicit hook script arguments to the project root', async () => {
    await expect(
      runNative(resolveHookArgv('/project', ['node', './hooks/setup.mjs', 'before_case'])),
    ).resolves.toEqual(['node', '/project/hooks/setup.mjs', 'before_case']);
  });

  test('keeps the default runtime working directory when workers are not configured', async () => {
    await expect(
      runNative(resolveWorkerDirectory('/project', 'run-1', 0, undefined)),
    ).resolves.toBeUndefined();
  });

  test('creates shared worker parents concurrently', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'attest-workers-concurrent-'));
    temporaryDirectories.push(projectRoot);

    const directories = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        runNative(
          prepareWorkerDirectory(projectRoot, join(projectRoot, 'workers', 'run-1', `${index}`)),
        ),
      ),
    );

    expect(new Set(directories).size).toBe(8);
  });

  test('rejects an explicit worker directory equal to the project root', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'attest-worker-root-'));
    temporaryDirectories.push(projectRoot);
    await expect(
      runNative(
        resolveWorkerDirectory(projectRoot, 'run-1', 0, {
          workers: { count: 1, directory: '.' },
        }),
      ),
    ).rejects.toThrow('Eval worker directory escapes the project');
    await expect(runNative(prepareWorkerDirectory(projectRoot, projectRoot))).rejects.toThrow(
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
      runNative(prepareWorkerDirectory(projectRoot, join(projectRoot, 'linked', 'worker-0'))),
    ).rejects.toThrow('Eval worker directory escapes the project through a symbolic link.');
  });

  test('requires distinct templates when multiple workers are configured', async () => {
    await expect(
      runNative(
        resolveWorkerDirectory('/project', 'run-1', 0, {
          workers: { count: 2, directory: '.attest/workers/{run_id}' },
        }),
      ),
    ).rejects.toThrow(
      'Eval worker directory must include {worker_index} when worker count exceeds one.',
    );
  });
});

/** Executes native test operations without converting production owners back to Promises. */
const runNative = async <A, E extends Error>(operation: Effect.Effect<A, E>) =>
  valueFromExit(await Effect.runPromiseExit(operation));
