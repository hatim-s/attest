import { valueFromExit } from '../../internal/effect-exit.js';
import * as Effect from 'effect/Effect';
import { openTestCatalog } from '../../store/_tests_/b1-fixture.js';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openTestStore as openStore, run as executeB1 } from '../../store/_tests_/b1-fixture.js';
import { registerProject, readRegistry } from '../index.js';

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
  await Effect.runPromiseExit(registerProject({ registryPath, root })).then(valueFromExit);

  return root;
};

describe('createRegistryCatalog', () => {
  it('reads a project without a store as empty and creates nothing', async () => {
    const home = await temporaryDirectory();
    const registryPath = join(home, 'projects.json');
    const root = await addProject(home, registryPath, 'fresh');
    const catalog = await openTestCatalog({ registryPath });
    const source = await executeB1(catalog.openProject('fresh'));
    expect(await executeB1(source.listRuns({}))).toEqual({ items: [] });
    await expect(executeB1(source.getRun('missing'))).rejects.toMatchObject({
      code: 'RUN_NOT_FOUND',
    });
    await expect(executeB1(source.listCaseSummaries('missing', {}))).rejects.toMatchObject({
      code: 'RUN_NOT_FOUND',
    });
    expect(await readdir(root)).toEqual([]);
    await catalog.close();
  });
  it('rejects a store at an older schema instead of migrating it', async () => {
    const home = await temporaryDirectory();
    const registryPath = join(home, 'projects.json');
    const root = await addProject(home, registryPath, 'pinned');
    await mkdir(join(root, '.attest'));
    // An empty file is a valid SQLite database with no tables, so every migration is pending.
    const storePath = join(root, '.attest', 'runs.db');
    await writeFile(storePath, '');
    const catalog = await openTestCatalog({ registryPath });
    await expect(executeB1(catalog.openProject('pinned'))).rejects.toMatchObject({
      code: 'SCHEMA_OUTDATED',
    });
    expect(await readFile(storePath)).toHaveLength(0);
    await catalog.close();
  });
  it('serves runs from an existing store and lists projects added after it started', async () => {
    const home = await temporaryDirectory();
    const registryPath = join(home, 'projects.json');
    const root = await addProject(home, registryPath, 'zeta');
    await mkdir(join(root, '.attest'));
    const store = await openStore(join(root, '.attest', 'runs.db'));

    const run = await executeB1(
      store.runs.createRun({
        schemaId: 'attest.project',
        configHash: 'c',
        configJson: '{}',
      }),
    );

    await store.close();
    const catalog = await openTestCatalog({ registryPath });

    // Parallel first requests share one store handle, so close() releases every handle.
    const [first, second] = await Promise.all([
      executeB1(catalog.openProject('zeta')),
      executeB1(catalog.openProject('zeta')),
    ]);

    expect(first).toBe(second);
    expect(
      (await executeB1((await executeB1(catalog.openProject('zeta'))).listRuns({}))).items.map(
        ({ id }) => id,
      ),
    ).toEqual([run.id]);
    await addProject(home, registryPath, 'alpha');
    expect((await executeB1(catalog.listProjects())).map(({ key }) => key)).toEqual([
      'alpha',
      'zeta',
    ]);
    await expect(executeB1(catalog.openProject('missing'))).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    });
    await catalog.close();
  });
});

it('does not cache a missing database and shares the database created later', async () => {
  const home = await temporaryDirectory();
  const registryPath = join(home, 'projects.json');
  const root = await addProject(home, registryPath, 'later');
  const catalog = await openTestCatalog({ registryPath });

  try {
    expect(await executeB1((await executeB1(catalog.openProject('later'))).listRuns())).toEqual({
      items: [],
    });
    await mkdir(join(root, '.attest'));
    const writer = await openStore(join(root, '.attest', 'runs.db'));

    const recorded = await executeB1(
      writer.runs.createRun({ schemaId: 'attest.project', configHash: 'later', configJson: '{}' }),
    );

    await writer.close();

    const [first, second] = await Promise.all([
      executeB1(catalog.openProject('later')),
      executeB1(catalog.openProject('later')),
    ]);

    expect(first).toBe(second);
    expect((await executeB1(first.listRuns())).items.map(({ id }) => id)).toEqual([recorded.id]);
  } finally {
    await catalog.close();
  }
});

it('retries a failed schema open after repair without caching the failure', async () => {
  const home = await temporaryDirectory();
  const registryPath = join(home, 'projects.json');
  const root = await addProject(home, registryPath, 'repair');
  await mkdir(join(root, '.attest'));
  const path = join(root, '.attest', 'runs.db');
  await writeFile(path, '');
  const catalog = await openTestCatalog({ registryPath });

  try {
    await expect(executeB1(catalog.openProject('repair'))).rejects.toMatchObject({
      code: 'SCHEMA_OUTDATED',
    });
    const writer = await openStore(path);
    await writer.close();
    expect(await executeB1((await executeB1(catalog.openProject('repair'))).listRuns())).toEqual({
      items: [],
    });
  } finally {
    await catalog.close();
  }
});

it('uses a new root when a registry key is removed and reassigned', async () => {
  const home = await temporaryDirectory();
  const registryPath = join(home, 'projects.json');
  const firstRoot = await addProject(home, registryPath, 'same');
  const secondRoot = join(home, 'replacement');
  await mkdir(secondRoot);

  for (const root of [firstRoot, secondRoot]) {
    await mkdir(join(root, '.attest'));
    const writer = await openStore(join(root, '.attest', 'runs.db'));
    await executeB1(
      writer.runs.createRun({ schemaId: 'attest.project', configHash: root, configJson: '{}' }),
    );
    await writer.close();
  }

  const catalog = await openTestCatalog({ registryPath });

  try {
    const first = await executeB1(catalog.openProject('same'));
    const registry = await executeB1(readRegistry(registryPath));
    await writeFile(
      registryPath,
      JSON.stringify({
        ...registry,
        projects: registry.projects.map((entry) => ({ ...entry, root: secondRoot })),
      }),
      { mode: 0o600 },
    );
    const second = await executeB1(catalog.openProject('same'));
    expect(second).not.toBe(first);
    expect((await executeB1(second.listRuns())).items[0]?.configHash).toBe(secondRoot);
  } finally {
    await catalog.close();
  }
});
