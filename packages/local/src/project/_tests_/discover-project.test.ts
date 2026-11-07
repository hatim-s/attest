import { valueFromExit } from '../../internal/effect-exit.js';
import * as Effect from 'effect/Effect';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverProject } from '../discover-project.js';

const temporaryDirectories: string[] = [];

/** Creates and tracks an isolated filesystem tree for project discovery tests. */
const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-project-discovery-'));
  const resolvedDirectory = await realpath(directory);
  temporaryDirectories.push(resolvedDirectory);

  return resolvedDirectory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('discoverProject', () => {
  it('discovers the closest parent manifest', async () => {
    const root = await createTemporaryDirectory();
    const nested = join(root, 'src', 'features');
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, 'attest.project.json'), '{}');

    await expect(
      Effect.runPromiseExit(discoverProject({ workingDirectory: nested })).then((exit) =>
        valueFromExit(exit),
      ),
    ).resolves.toEqual({
      manifestPath: join(root, 'attest.project.json'),
      root,
    });
  });

  it('does not cross a Git worktree boundary without an explicit project', async () => {
    const outer = await createTemporaryDirectory();
    const worktree = join(outer, 'repository');
    const nested = join(worktree, 'src');
    await mkdir(nested, { recursive: true });
    await writeFile(join(outer, 'attest.project.json'), '{}');
    await writeFile(join(worktree, '.git'), 'gitdir: /not/read/by-discovery\n');

    await expect(
      Effect.runPromiseExit(discoverProject({ workingDirectory: nested })).then((exit) =>
        valueFromExit(exit),
      ),
    ).rejects.toMatchObject({
      code: 'project_not_found',
    });
    await expect(
      Effect.runPromiseExit(discoverProject({ project: outer, workingDirectory: nested })).then(
        (exit) => valueFromExit(exit),
      ),
    ).resolves.toMatchObject({ root: outer });
  });

  it('requires an explicit project path to name the root itself', async () => {
    const root = await createTemporaryDirectory();
    const nested = join(root, 'nested');
    await mkdir(nested);
    await writeFile(join(root, 'attest.project.json'), '{}');

    await expect(
      Effect.runPromiseExit(discoverProject({ project: nested, workingDirectory: root })).then(
        (exit) => valueFromExit(exit),
      ),
    ).rejects.toMatchObject({ code: 'project_not_found' });
  });
});
