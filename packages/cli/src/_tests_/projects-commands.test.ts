import { access, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadProject } from '@attest/local/project';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCommand, runJson, temporaryDirectory } from './support/cli-test-support.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Points ATTEST_HOME at a fresh directory for one test and returns it. */
const useAttestHome = async (): Promise<string> => {
  const home = await temporaryDirectory('attest-home-');
  vi.stubEnv('ATTEST_HOME', home);

  return home;
};

describe('projects commands', () => {
  it('registers initialized projects and lists, adds and removes entries', async () => {
    await useAttestHome();
    // The registry stores each root's realpath.
    const parent = await realpath(await temporaryDirectory('attest-projects-'));

    expect((await runJson(parent, ['project', 'init', 'demo', '--name', 'Demo'])).exitCode).toBe(0);
    const demo = await loadProject({ project: join(parent, 'demo') });
    await mkdir(join(parent, 'plain'));
    const added = await runJson(parent, ['projects', 'add', 'plain']);

    expect(added.document).toMatchObject({
      ok: true,
      result: { key: 'plain', name: 'plain', root: join(parent, 'plain') },
    });

    const listed = await runJson(parent, ['projects', 'list']);

    expect(listed.document).toMatchObject({
      ok: true,
      command: 'projects.list',
      result: [
        {
          key: 'demo',
          name: 'Demo',
          root: join(parent, 'demo'),
          projectId: demo.project.project_id,
        },
        { key: 'plain', name: 'plain', root: join(parent, 'plain') },
      ],
    });

    expect((await runJson(parent, ['projects', 'remove', 'demo'])).exitCode).toBe(0);
    expect((await runCommand(parent, ['projects', 'list'])).output).toEqual([
      `  plain  plain  ${join(parent, 'plain')}`,
    ]);
  });

  it('follows symbolic links in an ATTEST_HOME that does not exist yet', async () => {
    const real = await realpath(await temporaryDirectory('attest-home-'));
    const linked = join(await temporaryDirectory('attest-link-'), 'home');
    await symlink(real, linked);
    vi.stubEnv('ATTEST_HOME', join(linked, 'first-run'));
    const parent = await temporaryDirectory('attest-projects-');
    await mkdir(join(parent, 'plain'));

    expect((await runJson(parent, ['projects', 'add', 'plain'])).exitCode).toBe(0);
    expect(await readFile(join(real, 'first-run', 'projects.json'), 'utf8')).toContain('"plain"');
  });

  it('keeps the manifest when init cannot write the registry', async () => {
    const home = await useAttestHome();
    // A file where the registry directory should be makes every registry write fail.
    await writeFile(join(home, 'blocked'), '');
    vi.stubEnv('ATTEST_HOME', join(home, 'blocked'));
    const parent = await temporaryDirectory('attest-projects-');

    const run = await runCommand(parent, ['project', 'init', 'second', '--output', 'json']);

    expect(run.exitCode).toBe(4);
    expect(JSON.parse(run.output[0] ?? '')).toMatchObject({
      ok: false,
      error: { code: 'registry_write_failed' },
    });
    await expect(access(join(parent, 'second', 'attest.project.json'))).resolves.toBeUndefined();
  });

  it('rejects view --all together with --store', async () => {
    await useAttestHome();
    const parent = await temporaryDirectory('attest-projects-');

    const run = await runCommand(parent, ['view', '--all', '--store', 'x.db', '--no-open']);

    expect(run.exitCode).toBe(2);
    expect(run.errors.join('\n')).toContain('cli_usage');
  });
});
