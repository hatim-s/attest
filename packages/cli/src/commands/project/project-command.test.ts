import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cliResultSchema } from '@attest/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli, type CliIo } from '../../run-cli.js';
import { loadProject } from '../../project/load-project.js';
import { writeFixtureProject } from '../../project/transaction/project-transaction.test-fixture.js';
import { runProjectInitCommand } from './project-init-command.js';

const FIXED_PROJECT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-cli2-project-'));
  temporaryDirectories.push(directory);
  return directory;
};

const collectIo = (): { errors: string[]; io: CliIo; output: string[] } => {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    errors,
    output,
    io: {
      output: (message) => output.push(message),
      error: (message) => errors.push(message),
    },
  };
};

const nonInteractive = {
  ci: false,
  inputIsTTY: false,
  outputIsTTY: false,
  prompt: (): Promise<string> => Promise.reject(new Error('prompt must not be called')),
  readStdin: (): Promise<string> => Promise.resolve(''),
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('CLI2.5 project shell', () => {
  it('initializes, shows, validates, and deterministically lists an empty v2 project', async () => {
    const parent = await createTemporaryDirectory();
    const initialized = collectIo();

    const initExitCode = await runCli(
      ['project', 'init', 'demo', '--name', 'Demo', '--output', 'json'],
      { interaction: nonInteractive, io: initialized.io, workingDirectory: parent },
    );

    expect(initExitCode).toBe(0);
    expect(initialized.errors).toEqual([]);
    expect(initialized.output).toHaveLength(1);
    const initResult = cliResultSchema.parse(JSON.parse(initialized.output[0] ?? '{}') as unknown);
    expect(initResult).toMatchObject({
      ok: true,
      command: 'project.init',
      project_hash_before: null,
      result: { committed: true, dry_run: false, project: { name: 'Demo' } },
    });

    const projectRoot = join(parent, 'demo');
    const loaded = await loadProject({ project: projectRoot });
    if (!initResult.ok) throw new Error('Expected project.init success.');
    expect(initResult.project_hash_after).toBe(loaded.projectHash);

    for (const argv of [
      ['project', 'show', '--output', 'json'],
      ['project', 'validate', '--output', 'json'],
      ['list', 'agents', '--output', 'json'],
    ]) {
      const first = collectIo();
      const second = collectIo();
      expect(
        await runCli(argv, {
          interaction: nonInteractive,
          io: first.io,
          workingDirectory: projectRoot,
        }),
      ).toBe(0);
      expect(
        await runCli(argv, {
          interaction: nonInteractive,
          io: second.io,
          workingDirectory: projectRoot,
        }),
      ).toBe(0);
      expect(second.output).toEqual(first.output);
      expect(first.output).toHaveLength(1);
    }
  });

  it('keeps TTY guidance and non-TTY defaults on the same normalized request path', async () => {
    const parent = await createTemporaryDirectory();
    const guided = collectIo();
    const questions: string[] = [];
    await runCli(['project', 'init', 'guided'], {
      workingDirectory: parent,
      io: guided.io,
      interaction: {
        ci: false,
        inputIsTTY: true,
        outputIsTTY: true,
        prompt: (question) => {
          questions.push(question);
          return Promise.resolve('Guided Project');
        },
      },
    });
    expect(questions).toEqual(['Project name [guided]: ']);
    await expect(loadProject({ project: join(parent, 'guided') })).resolves.toMatchObject({
      project: { name: 'Guided Project' },
    });

    const automatic = collectIo();
    await runCli(['project', 'init', 'automatic'], {
      workingDirectory: parent,
      io: automatic.io,
      interaction: nonInteractive,
    });
    await expect(loadProject({ project: join(parent, 'automatic') })).resolves.toMatchObject({
      project: { name: 'automatic' },
    });
  });

  it('accepts a complete project.init request from stdin and preserves the init alias', async () => {
    const parent = await createTemporaryDirectory();
    const request = JSON.stringify({
      schema: 'attest.command-request/v2',
      command: 'project.init',
      directory: 'stdin-project',
      name: 'Stdin Project',
    });
    const stdin = collectIo();
    const exitCode = await runCli(['project', 'init', '--from-json', '-', '--output', 'json'], {
      workingDirectory: parent,
      io: stdin.io,
      interaction: { ...nonInteractive, readStdin: () => Promise.resolve(request) },
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdin.output[0] ?? '{}')).toMatchObject({
      ok: true,
      command: 'project.init',
      result: { project: { name: 'Stdin Project' } },
    });

    const alias = collectIo();
    expect(
      await runCli(['init', 'alias-project', '--name', 'Alias', '--output', 'json'], {
        workingDirectory: parent,
        io: alias.io,
        interaction: nonInteractive,
      }),
    ).toBe(0);
    expect(JSON.parse(alias.output[0] ?? '{}')).toMatchObject({
      ok: true,
      command: 'project.init',
    });

    const help = collectIo();
    await runCli(['help', 'init', '--output', 'json'], {
      workingDirectory: parent,
      io: help.io,
      interaction: nonInteractive,
    });
    expect(JSON.parse(help.output[0] ?? '{}')).toMatchObject({
      result: { command: { alias_for: 'project.init' } },
    });
  });

  it('returns a semantic dry run with deterministic injected identity and zero writes', async () => {
    const parent = await createTemporaryDirectory();
    const before = await readdir(parent);
    const options = {
      createProjectId: () => FIXED_PROJECT_ID,
      directory: 'preview',
      dryRun: true,
      interactive: false,
      name: 'Preview',
      readStdin: () => Promise.resolve(''),
      workingDirectory: parent,
    };

    const first = await runProjectInitCommand(options);
    const second = await runProjectInitCommand(options);

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      projectHashBefore: null,
      result: {
        committed: false,
        dry_run: true,
        operations: [{ op: 'add', resource: { type: 'project' } }],
      },
    });
    expect(await readdir(parent)).toEqual(before);
    await expect(access(join(parent, 'preview'))).rejects.toBeDefined();
  });

  it('reports an expected-project-hash conflict without writing', async () => {
    const parent = await createTemporaryDirectory();
    const response = collectIo();
    const exitCode = await runCli(
      [
        'project',
        'init',
        'conflict',
        '--name',
        'Conflict',
        '--if-project-hash',
        'a'.repeat(64),
        '--output',
        'json',
      ],
      { workingDirectory: parent, io: response.io, interaction: nonInteractive },
    );

    expect(exitCode).toBe(3);
    expect(response.errors).toEqual([]);
    expect(JSON.parse(response.output[0] ?? '{}')).toMatchObject({
      ok: false,
      command: 'project.init',
      error: { code: 'project_changed', details: { current_hash: null } },
    });
    await expect(access(join(parent, 'conflict'))).rejects.toBeDefined();

    const globalFirst = collectIo();
    expect(
      await runCli(['--output', 'json', '--project', 'missing', 'project', 'validate'], {
        workingDirectory: parent,
        io: globalFirst.io,
        interaction: nonInteractive,
      }),
    ).toBe(1);
    expect(JSON.parse(globalFirst.output[0] ?? '{}')).toMatchObject({
      ok: false,
      command: 'project.validate',
      error: { code: 'project_read_failed' },
    });
  });

  it('rolls back a published manifest when post-publication verification fails', async () => {
    const parent = await createTemporaryDirectory();
    const root = join(parent, 'rollback');

    await expect(
      runProjectInitCommand({
        createProjectId: () => FIXED_PROJECT_ID,
        directory: 'rollback',
        interactive: false,
        name: 'Rollback',
        publishObserver: () => {
          throw new Error('injected publish failure');
        },
        readStdin: () => Promise.resolve(''),
        workingDirectory: parent,
      }),
    ).rejects.toMatchObject({ code: 'init_failed' });
    await expect(access(join(root, 'attest.project.json'))).rejects.toBeDefined();
    await expect(access(root)).rejects.toBeDefined();
  });

  it('lists and shows canonical resources, then returns aggregate validation diagnostics', async () => {
    const root = await createTemporaryDirectory();
    await writeFixtureProject(root);

    const list = collectIo();
    await runCli(['list', 'agents', '--output', 'json'], {
      workingDirectory: root,
      io: list.io,
      interaction: nonInteractive,
    });
    expect(JSON.parse(list.output[0] ?? '{}')).toMatchObject({
      result: { items: [{ id: 'support', transport: 'native_cli' }] },
    });

    const show = collectIo();
    await runCli(['show', 'agent', 'support', '--output', 'json'], {
      workingDirectory: root,
      io: show.io,
      interaction: nonInteractive,
    });
    expect(JSON.parse(show.output[0] ?? '{}')).toMatchObject({
      result: { resource: { id: 'support', name: 'Support' } },
    });

    const missing = collectIo();
    expect(
      await runCli(['show', 'agent', 'missing', '--output', 'json'], {
        workingDirectory: root,
        io: missing.io,
        interaction: nonInteractive,
      }),
    ).toBe(1);
    expect(JSON.parse(missing.output[0] ?? '{}')).toMatchObject({
      error: { code: 'resource_not_found' },
    });

    const agentPath = join(root, 'attest', 'agents', 'support.json');
    const original = JSON.parse(await readFile(agentPath, 'utf8')) as Record<string, unknown>;
    await writeFile(agentPath, `${JSON.stringify({ ...original, secret: 'must-not-render' })}\n`);
    const validation = collectIo();
    expect(
      await runCli(['project', 'validate', '--output', 'json'], {
        workingDirectory: root,
        io: validation.io,
        interaction: nonInteractive,
      }),
    ).toBe(1);
    expect(validation.output.join('')).not.toContain('must-not-render');
    expect(JSON.parse(validation.output[0] ?? '{}')).toMatchObject({
      error: { code: 'project_invalid' },
    });
  });
});
