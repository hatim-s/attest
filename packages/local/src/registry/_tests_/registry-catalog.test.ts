import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openStore } from '../../store/index.js';
import { createRegistryCatalog, registerProject } from '../index.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'attest-registry-catalog-'));
  directories.push(directory);

  return directory;
};

/** Registers `<home>/<name>` and returns its root. */
const addProject = async (home: string, registryPath: string, name: string): Promise<string> => {
  const root = join(home, name);
  await mkdir(root);
  await registerProject({ registryPath, root });

  return root;
};

describe('createRegistryCatalog', () => {
  it('reads a project without a store as empty and creates nothing', async () => {
    const home = await temporaryDirectory();
    const registryPath = join(home, 'projects.json');
    const root = await addProject(home, registryPath, 'fresh');
    const catalog = createRegistryCatalog({ registryPath });

    const source = await catalog.openProject('fresh');

    expect(await source.listRuns({})).toEqual({ items: [] });
    await expect(source.getRun('missing')).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
    await expect(source.listCaseSummaries('missing', {})).rejects.toMatchObject({
      code: 'RUN_NOT_FOUND',
    });
    expect(await readdir(root)).toEqual([]);
    await catalog.close();
  });

  it('serves runs from an existing store and lists projects added after it started', async () => {
    const home = await temporaryDirectory();
    const registryPath = join(home, 'projects.json');
    const root = await addProject(home, registryPath, 'zeta');
    await mkdir(join(root, '.attest'));
    const store = await openStore(join(root, '.attest', 'runs.db'));

    const run = await store.runs.createRun({
      schemaId: 'attest.project',
      configHash: 'c',
      configJson: '{}',
    });

    await store.close();
    const catalog = createRegistryCatalog({ registryPath });

    // Parallel first requests share one store handle, so close() releases every handle.
    const [first, second] = await Promise.all([
      catalog.openProject('zeta'),
      catalog.openProject('zeta'),
    ]);

    expect(first).toBe(second);

    expect(
      (await (await catalog.openProject('zeta')).listRuns({})).items.map(({ id }) => id),
    ).toEqual([run.id]);

    await addProject(home, registryPath, 'alpha');
    expect((await catalog.listProjects()).map(({ key }) => key)).toEqual(['alpha', 'zeta']);
    await expect(catalog.openProject('missing')).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    });
    await catalog.close();
  });
});
