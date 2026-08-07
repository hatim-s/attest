import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cliResultSchema } from '@attest/contracts';
import { openStore } from '@attest/core';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli, type CliIo } from '../../run-cli.js';
import { loadProject } from '../../project/load-project.js';
import { prepareProjectCandidate } from '../../project/transaction/candidate-project.js';
import {
  candidateFromLoadedProject,
  writeFixtureProject,
} from '../../project/transaction/project-transaction.test-fixture.js';
import { acquireProjectLock, releaseProjectLock } from '../../project/transaction/project-lock.js';
import { prepareTransaction } from '../../project/transaction/transaction-journal.js';
import {
  applyProjectMutation,
  createFileChanges,
  publishPreparedTransaction,
} from '../../project/transaction/transactional-writer.js';
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
    const metricPath = join(root, 'attest', 'metrics', 'correct.json');
    const originalMetric = JSON.parse(await readFile(metricPath, 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(
      metricPath,
      `${JSON.stringify({ ...originalMetric, secret: 'second-must-not-render' })}\n`,
    );
    const validation = collectIo();
    expect(
      await runCli(['project', 'validate', '--output', 'json'], {
        workingDirectory: root,
        io: validation.io,
        interaction: nonInteractive,
      }),
    ).toBe(1);
    expect(validation.output.join('')).not.toContain('must-not-render');
    const failure = JSON.parse(validation.output[0] ?? '{}') as {
      error: { code: string; details: { diagnostics: { source: string }[] } };
    };
    expect(failure.error.code).toBe('project_invalid');
    expect(Array.isArray(failure.error.details.diagnostics)).toBe(true);
    expect(failure.error.details.diagnostics.map(({ source }) => source)).toEqual(
      [...failure.error.details.diagnostics.map(({ source }) => source)].sort(),
    );
    expect(failure.error.details.diagnostics.map(({ source }) => source)).toEqual(
      expect.arrayContaining(['attest/agents/support.json', 'attest/metrics/correct.json']),
    );
  });

  it('redacts authored transport credentials from human and JSON resource output', async () => {
    const root = await createTemporaryDirectory();
    await writeFixtureProject(root);
    const loaded = await loadProject({ project: root });
    const candidate = candidateFromLoadedProject(loaded);
    candidate.agents[0]!.transport = {
      kind: 'http',
      lifecycle: 'external',
      request: {
        url: 'https://example.test/invoke',
        method: 'POST',
        headers: { Authorization: 'Bearer authored-agent-secret' },
        query: { api_key: 'authored-query-secret' },
      },
      extraction: { result_pointer: '/result' },
    };
    candidate.agents.push({
      ...structuredClone(candidate.agents[0]!),
      id: 'worker',
      name: 'Worker',
      transport: {
        kind: 'native_cli',
        lifecycle: 'per_case',
        argv: ['node', 'authored-argv-secret'],
      },
      redaction: { argv_positions: [1] },
    });
    candidate.metrics[0]!.definition = {
      kind: 'http',
      request: {
        url: 'https://example.test/metric',
        method: 'POST',
        headers: { 'X-Api-Key': 'authored-metric-secret' },
      },
      extraction: { score_pointer: '/score', pass_pointer: '/pass' },
    };
    await applyProjectMutation({ candidate, projectRoot: root });

    for (const argv of [
      ['show', 'agent', 'support'],
      ['show', 'agent', 'worker', '--output', 'json'],
      ['show', 'metric', 'correct', '--output', 'json'],
    ]) {
      const response = collectIo();
      expect(
        await runCli(argv, {
          workingDirectory: root,
          io: response.io,
          interaction: nonInteractive,
        }),
      ).toBe(0);
      const output = response.output.join('\n');
      expect(output).toContain('[REDACTED]');
      expect(output).not.toMatch(/authored-(?:agent|query|argv|metric)-secret/u);
    }
  });

  it('inspects runs without creating, migrating, or changing project-local store files', async () => {
    const root = await createTemporaryDirectory();
    await writeFixtureProject(root);
    const absent = collectIo();
    expect(
      await runCli(['list', 'runs', '--output', 'json'], {
        workingDirectory: root,
        io: absent.io,
        interaction: nonInteractive,
      }),
    ).toBe(0);
    await expect(access(join(root, '.attest'))).rejects.toBeDefined();

    const storePath = join(root, '.attest', 'runs.db');
    await mkdir(join(root, '.attest'));
    const store = await openStore(storePath);
    const run = await store.runs.createRun({
      configVersion: 'v2',
      configHash: 'safe-hash',
      configJson: '{"secret":"must-not-render"}',
    });
    await store.close();
    const beforeBytes = await readFile(storePath);
    const beforeFiles = await readdir(join(root, '.attest'));

    for (const argv of [
      ['list', 'runs', '--output', 'json'],
      ['show', 'run', run.id, '--output', 'json'],
    ]) {
      const response = collectIo();
      expect(
        await runCli(argv, {
          workingDirectory: root,
          io: response.io,
          interaction: nonInteractive,
        }),
      ).toBe(0);
      expect(response.output.join('')).not.toContain('must-not-render');
    }
    expect(await readFile(storePath)).toEqual(beforeBytes);
    expect(await readdir(join(root, '.attest'))).toEqual(beforeFiles);

    await rm(storePath);
    const outside = join(await createTemporaryDirectory(), 'outside.db');
    await writeFile(outside, beforeBytes);
    await symlink(outside, storePath);
    const unsafe = collectIo();
    expect(
      await runCli(['list', 'runs', '--output', 'json'], {
        workingDirectory: root,
        io: unsafe.io,
        interaction: nonInteractive,
      }),
    ).toBe(1);
    expect(JSON.parse(unsafe.output[0] ?? '{}')).toMatchObject({
      error: { code: 'project_read_failed' },
    });

    await rm(join(root, '.attest'), { recursive: true });
    const outsideDirectory = await createTemporaryDirectory();
    const outsideStore = join(outsideDirectory, 'runs.db');
    await writeFile(outsideStore, beforeBytes);
    await symlink(outsideDirectory, join(root, '.attest'));
    const outsideBefore = await readFile(outsideStore);
    const escaped = collectIo();
    expect(
      await runCli(['list', 'runs', '--output', 'json'], {
        workingDirectory: root,
        io: escaped.io,
        interaction: nonInteractive,
      }),
    ).toBe(1);
    expect(JSON.parse(escaped.output[0] ?? '{}')).toMatchObject({
      error: { code: 'project_read_failed' },
    });
    expect(await readFile(outsideStore)).toEqual(outsideBefore);
  });

  it('recovers pre-manifest and post-manifest journals before returning a project snapshot', async () => {
    for (const publishManifest of [false, true]) {
      const root = await createTemporaryDirectory();
      await writeFixtureProject(root);
      const loaded = await loadProject({ project: root });
      const candidate = candidateFromLoadedProject(loaded);
      candidate.agents[0]!.name = publishManifest ? 'Committed snapshot' : 'Rolled back snapshot';
      candidate.metrics[0]!.name = 'Changed metric';
      const preparedCandidate = prepareProjectCandidate(candidate);
      const lock = await acquireProjectLock(root);
      const prepared = await prepareTransaction(
        root,
        createFileChanges(loaded, preparedCandidate),
        loaded.projectHash,
        preparedCandidate.projectHash,
      );
      try {
        if (publishManifest) {
          await publishPreparedTransaction(root, prepared);
        } else {
          await expect(
            publishPreparedTransaction(root, prepared, ({ index }) => {
              if (index === 0) throw new Error('simulated interruption');
            }),
          ).rejects.toThrow('simulated interruption');
        }
      } finally {
        await releaseProjectLock(lock);
      }

      const response = collectIo();
      expect(
        await runCli(['project', 'show', '--output', 'json'], {
          workingDirectory: root,
          io: response.io,
          interaction: nonInteractive,
        }),
      ).toBe(0);
      const result = JSON.parse(response.output[0] ?? '{}') as {
        result: { project_hash: string };
      };
      expect(result.result.project_hash).toBe(
        publishManifest ? preparedCandidate.projectHash : loaded.projectHash,
      );
      expect(await readdir(join(root, '.attest', 'transactions'))).toEqual([]);
    }
  });

  it('returns a stable lock conflict instead of observing a paused publication', async () => {
    const root = await createTemporaryDirectory();
    await writeFixtureProject(root);
    const loaded = await loadProject({ project: root });
    const candidate = candidateFromLoadedProject(loaded);
    candidate.agents[0]!.name = 'New snapshot';
    let releasePublication!: () => void;
    let signalPublished!: () => void;
    const publicationPaused = new Promise<void>((resolve) => {
      signalPublished = resolve;
    });
    const publicationGate = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const mutation = applyProjectMutation(
      { candidate, projectRoot: root },
      {
        publishObserver: async ({ index }) => {
          if (index === 0) {
            signalPublished();
            await publicationGate;
          }
        },
      },
    );
    await publicationPaused;

    const response = collectIo();
    expect(
      await runCli(['project', 'show', '--output', 'json'], {
        workingDirectory: root,
        io: response.io,
        interaction: nonInteractive,
      }),
    ).toBe(3);
    expect(JSON.parse(response.output[0] ?? '{}')).toMatchObject({
      error: { code: 'project_locked' },
    });
    releasePublication();
    await mutation;
  });
});
