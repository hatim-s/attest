import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { addProject, readRegistry, registerProject, unregisterProject } from '../index.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** A real (symlink-free) temporary directory; macOS `tmpdir()` sits behind `/var`. */
const temporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), prefix));
  directories.push(directory);

  return directory;
};

const projectDirectory = async (parent: string, name: string): Promise<string> => {
  const directory = join(parent, name);
  await mkdir(directory);

  return directory;
};

describe('project registry', () => {
  it('reads a missing registry as empty and writes a private file on first registration', async () => {
    const home = await temporaryDirectory('attest-registry-');
    const registryPath = join(home, 'attest', 'projects.json');

    expect(await readRegistry(registryPath)).toEqual({
      schema: 'attest.projects.v1',
      projects: [],
    });

    const root = await projectDirectory(home, 'workflow');
    const entry = await registerProject({ registryPath, root, projectId: '01PROJECT' });

    expect(entry).toMatchObject({
      key: 'workflow',
      name: 'workflow',
      root,
      projectId: '01PROJECT',
    });
    expect(await readRegistry(registryPath)).toEqual({
      schema: 'attest.projects.v1',
      projects: [entry],
    });
    expect((await stat(registryPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, 'attest'))).mode & 0o777).toBe(0o700);
  });

  it('slugs names, dedupes keys and keeps the first registration of a root', async () => {
    const home = await temporaryDirectory('attest-registry-');
    const registryPath = join(home, 'projects.json');
    const first = await projectDirectory(home, 'one');
    const second = await projectDirectory(home, 'two');
    const third = await projectDirectory(home, 'three');

    const registered = [
      await registerProject({ registryPath, root: first, name: '  My Agent: Evals! ' }),
      await registerProject({ registryPath, root: second, name: 'my agent evals' }),
      await registerProject({ registryPath, root: third, name: 'MY-AGENT-EVALS' }),
    ];

    expect(registered.map(({ key }) => key)).toEqual([
      'my-agent-evals',
      'my-agent-evals-2',
      'my-agent-evals-3',
    ]);

    // The same directory through a symlink is the same root; neither name nor key changes.
    const alias = join(home, 'alias');
    await symlink(first, alias);
    expect(await registerProject({ registryPath, root: alias, name: 'Renamed' })).toEqual(
      registered[0],
    );
    expect((await readRegistry(registryPath)).projects).toHaveLength(3);
  });

  it('removes an entry by key or by directory', async () => {
    const home = await temporaryDirectory('attest-registry-');
    const registryPath = join(home, 'projects.json');
    const first = await registerProject({ registryPath, root: await projectDirectory(home, 'a') });
    const second = await registerProject({ registryPath, root: await projectDirectory(home, 'b') });

    await unregisterProject({ registryPath, keyOrRoot: 'a', workingDirectory: home });
    await unregisterProject({ registryPath, keyOrRoot: './b', workingDirectory: home });

    expect((await readRegistry(registryPath)).projects).toEqual([]);
    expect([first.key, second.key]).toEqual(['a', 'b']);
    await expect(
      unregisterProject({ registryPath, keyOrRoot: 'a', workingDirectory: home }),
    ).rejects.toMatchObject({ code: 'resource_not_found' });
  });

  it('takes name and id from a manifest when adding a directory', async () => {
    const home = await temporaryDirectory('attest-registry-');
    const registryPath = join(home, 'projects.json');
    const root = await projectDirectory(home, 'checkout');
    await writeFile(
      join(root, 'attest.project.json'),
      JSON.stringify({
        schema: 'attest.project',
        project_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        name: 'Support Bot',
        resources: { agents: [], datasets: [], metrics: [], tests: [] },
      }),
    );

    expect(
      await addProject({ registryPath, directory: 'checkout', workingDirectory: home }),
    ).toMatchObject({
      key: 'support-bot',
      name: 'Support Bot',
      projectId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    });
  });

  it('keeps both of two concurrent registrations', async () => {
    const home = await temporaryDirectory('attest-registry-');
    const registryPath = join(home, 'projects.json');
    const roots = [await projectDirectory(home, 'left'), await projectDirectory(home, 'right')];

    await Promise.all(roots.map((root) => registerProject({ registryPath, root })));

    expect((await readRegistry(registryPath)).projects.map(({ root }) => root).sort()).toEqual(
      roots,
    );
    await expect(stat(`${registryPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects malformed registries and symlinked ancestors', async () => {
    const home = await temporaryDirectory('attest-registry-');
    const registryPath = join(home, 'projects.json');

    for (const content of [
      '{',
      JSON.stringify({ schema: 'attest.projects.v0', projects: [] }),
      JSON.stringify({ schema: 'attest.projects.v1', projects: [], extra: true }),
      JSON.stringify({
        schema: 'attest.projects.v1',
        projects: [
          { key: 'a', name: 'a', root: '/a', registeredAt: '2026-10-18T12:00:00.000Z' },
          { key: 'a', name: 'b', root: '/b', registeredAt: '2026-10-18T12:00:00.000Z' },
        ],
      }),
      JSON.stringify({
        schema: 'attest.projects.v1',
        projects: [
          { key: 'a', name: 'a', root: 'relative/a', registeredAt: '2026-10-18T12:00:00.000Z' },
        ],
      }),
    ]) {
      // Private mode, so each case fails on its content and not on the file permissions.
      await writeFile(registryPath, content, { mode: 0o600 });
      await expect(readRegistry(registryPath)).rejects.toMatchObject({ code: 'registry_invalid' });
    }

    const linked = join(home, 'linked');
    await symlink(home, linked);
    await expect(readRegistry(join(linked, 'projects.json'))).rejects.toMatchObject({
      code: 'registry_invalid',
    });
    await expect(
      registerProject({ registryPath: join(linked, 'nested', 'projects.json'), root: home }),
    ).rejects.toMatchObject({ code: 'registry_write_failed' });
    expect(await readFile(registryPath, 'utf8')).toContain('"a"');
  });
});
