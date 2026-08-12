import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cliResultSchema } from '@attest/contracts';
import { openStore } from '@attest/core';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli, type CliIo } from '../../../run-cli.js';
import { loadProject } from '../../../project/load-project.js';
import { prepareProjectCandidate } from '../../../project/transaction/candidate-project.js';
import {
  candidateFromLoadedProject,
  writeFixtureProject,
} from '../../../project/transaction/_tests/support/project-transaction.js';
import {
  acquireProjectLock,
  releaseProjectLock,
} from '../../../project/transaction/project-lock.js';
import { prepareTransaction } from '../../../project/transaction/transaction-journal.js';
import {
  applyProjectMutation,
  createFileChanges,
  publishPreparedTransaction,
} from '../../../project/transaction/transactional-writer.js';
import { withReadonlyRunStore } from '../../run-store/readonly-run-store.js';
import { removeRunStoreSnapshot } from '../../run-store/run-store-snapshot.js';
import { runProjectInitCommand, type ProjectInitFileStep } from '../project-init-command.js';

const FIXED_PROJECT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-project-'));
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

/** Captures exact file bytes for project-local no-write assertions. */
const snapshotDirectory = async (directory: string): Promise<Record<string, Buffer>> => {
  const entries = (await readdir(directory)).sort();
  return Object.fromEntries(
    await Promise.all(
      entries.map(async (entry) => [entry, await readFile(join(directory, entry))] as const),
    ),
  );
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('project shell', () => {
  it('initializes, shows, validates, and deterministically lists an empty project', async () => {
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
      schema: 'attest.command-request',
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

    const localProject = collectIo();
    expect(
      await runCli(['project', 'validate', '--output', 'json', '--project', 'missing'], {
        workingDirectory: parent,
        io: localProject.io,
        interaction: nonInteractive,
      }),
    ).toBe(1);
    expect(JSON.parse(localProject.output[0] ?? '{}')).toMatchObject({
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

  it('cleans every preparation fault and surfaces manifest rollback failure as recovery', async () => {
    const preparationSteps: ProjectInitFileStep[] = [
      'temporary_open',
      'temporary_write',
      'temporary_sync',
      'temporary_close',
      'manifest_link',
      'temporary_unlink',
      'directory_open',
      'directory_sync',
      'directory_close',
    ];
    for (const step of preparationSteps) {
      const root = join(await createTemporaryDirectory(), step);
      await mkdir(root);
      await writeFile(join(root, 'sentinel.txt'), 'unchanged\n');
      await expect(
        runProjectInitCommand({
          createProjectId: () => FIXED_PROJECT_ID,
          directory: root,
          faultInjector: (currentStep) => {
            if (currentStep === step) throw new Error(`injected ${step}`);
          },
          interactive: false,
          name: 'Fault test',
          readStdin: () => Promise.resolve(''),
          workingDirectory: root,
        }),
      ).rejects.toMatchObject({ code: 'init_failed' });
      expect(await readdir(root)).toEqual(['sentinel.txt']);
      expect(await readFile(join(root, 'sentinel.txt'), 'utf8')).toBe('unchanged\n');
    }

    const parent = await createTemporaryDirectory();
    const root = join(parent, 'recovery');
    await expect(
      runProjectInitCommand({
        createProjectId: () => FIXED_PROJECT_ID,
        directory: 'recovery',
        faultInjector: (step) => {
          if (step === 'rollback_manifest_unlink') throw new Error('injected rollback failure');
        },
        interactive: false,
        name: 'Recovery',
        publishObserver: () => {
          throw new Error('injected verification failure');
        },
        readStdin: () => Promise.resolve(''),
        workingDirectory: parent,
      }),
    ).rejects.toMatchObject({ code: 'project_recovery_required' });
    expect(await readdir(root)).toEqual(['attest.project.json']);
    await expect(loadProject({ project: root })).resolves.toMatchObject({
      project: { name: 'Recovery' },
    });
  });

  it('rejects every overlapping init request source before reading stdin or writing', async () => {
    const parent = await createTemporaryDirectory();
    const requestPath = join(parent, 'request.json');
    await writeFile(
      requestPath,
      JSON.stringify({
        schema: 'attest.command-request',
        command: 'project.init',
        directory: 'request-project',
        name: 'Request Project',
      }),
    );

    const cases: { argv: string[]; expected: string[]; readStdin?: () => Promise<string> }[] = [
      {
        argv: ['project', 'init', 'positional', '--project', 'flag-project', '--output', 'json'],
        expected: ['directory', 'project'],
      },
      {
        argv: ['project', 'init', 'positional', '--from-json', requestPath, '--output', 'json'],
        expected: ['directory'],
      },
      {
        argv: [
          'project',
          'init',
          '--from-json',
          '-',
          '--name',
          'Flag Name',
          '--dry-run',
          '--output',
          'json',
        ],
        expected: ['dry-run', 'name'],
        readStdin: () => Promise.reject(new Error('stdin must not be consumed on conflict')),
      },
    ];
    for (const testCase of cases) {
      const response = collectIo();
      expect(
        await runCli(testCase.argv, {
          workingDirectory: parent,
          io: response.io,
          interaction: {
            ...nonInteractive,
            ...(testCase.readStdin === undefined ? {} : { readStdin: testCase.readStdin }),
          },
        }),
      ).toBe(2);
      expect(JSON.parse(response.output[0] ?? '{}')).toMatchObject({
        error: {
          code: 'cli_usage',
          details: { conflicting_fields: testCase.expected },
        },
      });
    }
    expect((await readdir(parent)).sort()).toEqual(['request.json']);

    const help = collectIo();
    await runCli(['help', 'project', 'init', '--output', 'json'], {
      workingDirectory: parent,
      io: help.io,
      interaction: nonInteractive,
    });
    const helpDocument = JSON.parse(help.output[0] ?? '{}') as {
      result: { command: { options: { conflicts: string[]; name: string }[] } };
    };
    expect(
      helpDocument.result.command.options.find(({ name }) => name === 'from-json')?.conflicts,
    ).toEqual(['directory', 'project', 'name', 'dry-run', 'yes', 'if-project-hash']);
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
      response_mode: 'mapped',
      request: {
        url: 'https://user:authored-url-password@example.test/invoke?token=authored-url-token',
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
        url: 'https://user:authored-metric-url-password@example.test/metric?token=authored-metric-url-token',
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
      expect(output).not.toMatch(
        /authored-(?:agent|query|argv|metric)-secret|authored-(?:url|metric-url)-(?:password|token)/u,
      );
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
      schemaId: 'attest.project',
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

  it('reads committed WAL rows from a live writer without changing source files', async () => {
    const root = await createTemporaryDirectory();
    await writeFixtureProject(root);
    const storeDirectory = join(root, '.attest');
    const storePath = join(storeDirectory, 'runs.db');
    await mkdir(storeDirectory);
    const writer = await openStore(storePath);
    try {
      const run = await writer.runs.createRun({
        schemaId: 'attest.project',
        configHash: 'live-wal',
        configJson: '{}',
      });
      expect(await readdir(storeDirectory)).toContain('runs.db-wal');
      const before = await snapshotDirectory(storeDirectory);

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
        expect(response.output.join('')).toContain(run.id);
      }
      expect(await snapshotDirectory(storeDirectory)).toEqual(before);
    } finally {
      await writer.close();
    }
  });

  it('queries the anchored snapshot when the source pathname is swapped after capture', async () => {
    const root = await createTemporaryDirectory();
    await writeFixtureProject(root);
    const storeDirectory = join(root, '.attest');
    const storePath = join(storeDirectory, 'runs.db');
    await mkdir(storeDirectory);
    const sourceWriter = await openStore(storePath);
    const sourceRun = await sourceWriter.runs.createRun({
      schemaId: 'attest.project',
      configHash: 'anchored-source',
      configJson: '{}',
    });
    await sourceWriter.close();

    const outsideDirectory = await createTemporaryDirectory();
    const outsidePath = join(outsideDirectory, 'outside.db');
    const outsideWriter = await openStore(outsidePath);
    const outsideRun = await outsideWriter.runs.createRun({
      schemaId: 'attest.project',
      configHash: 'outside-source',
      configJson: '{}',
    });
    await outsideWriter.close();

    const backupPath = join(storeDirectory, 'runs.db-original');
    let swapped = false;
    try {
      const ids = await withReadonlyRunStore(
        root,
        async (store) => (await store.listRuns()).map(({ id }) => id),
        {
          afterSnapshotCaptured: async () => {
            await rename(storePath, backupPath);
            await symlink(outsidePath, storePath);
            swapped = true;
          },
        },
      );
      expect(ids).toEqual([sourceRun.id]);
      expect(ids).not.toContain(outsideRun.id);
    } finally {
      if (swapped) {
        await rm(storePath);
        await rename(backupPath, storePath);
      }
    }
  });

  it('rejects a parent-directory swap before capturing any outside database', async () => {
    const root = await createTemporaryDirectory();
    await writeFixtureProject(root);
    const storeDirectory = join(root, '.attest');
    await mkdir(storeDirectory);
    const sourceWriter = await openStore(join(storeDirectory, 'runs.db'));
    await sourceWriter.runs.createRun({
      schemaId: 'attest.project',
      configHash: 'intended-source',
      configJson: '{}',
    });
    await sourceWriter.close();

    const outsideDirectory = await createTemporaryDirectory();
    const outsideWriter = await openStore(join(outsideDirectory, 'runs.db'));
    await outsideWriter.runs.createRun({
      schemaId: 'attest.project',
      configHash: 'outside-source',
      configJson: '{}',
    });
    await outsideWriter.close();

    const backupDirectory = join(root, '.attest-original');
    let swapped = false;
    let queried = false;
    try {
      await expect(
        withReadonlyRunStore(
          root,
          () => {
            queried = true;
            return Promise.resolve([]);
          },
          {
            beforeAnchorOpen: async () => {
              await rename(storeDirectory, backupDirectory);
              await symlink(outsideDirectory, storeDirectory);
              swapped = true;
            },
          },
        ),
      ).rejects.toMatchObject({ code: 'project_read_failed' });
      expect(queried).toBe(false);
    } finally {
      if (swapped) {
        await rm(storeDirectory);
        await rename(backupDirectory, storeDirectory);
      }
    }
  });

  it('attempts every read cleanup while preserving the primary or first cleanup failure', async () => {
    for (const primaryError of [undefined, new Error('injected operation failure')]) {
      const root = await createTemporaryDirectory();
      await writeFixtureProject(root);
      const storeDirectory = join(root, '.attest');
      await mkdir(storeDirectory);
      const writer = await openStore(join(storeDirectory, 'runs.db'));
      await writer.runs.createRun({
        schemaId: 'attest.project',
        configHash: 'cleanup-source',
        configJson: '{}',
      });
      await writer.close();

      const storeCloseError = new Error('injected store close failure');
      const removalError = new Error('injected snapshot removal failure');
      const anchorCloseError = new Error('injected anchor close failure');
      const cleanupOrder: string[] = [];
      let removedDirectory: string | undefined;
      const inspection = withReadonlyRunStore(
        root,
        async (store) => {
          if (primaryError !== undefined) throw primaryError;
          return store.listRuns();
        },
        {
          cleanup: {
            closeStore: async (store) => {
              cleanupOrder.push('store');
              await store.close();
              throw storeCloseError;
            },
            removeSnapshot: async (snapshot) => {
              cleanupOrder.push('snapshot');
              removedDirectory = snapshot.directory;
              await removeRunStoreSnapshot(snapshot);
              throw removalError;
            },
            closeAnchor: async (anchor) => {
              cleanupOrder.push('anchor');
              await anchor.close();
              throw anchorCloseError;
            },
          },
        },
      );

      const observedError = await inspection.then(
        () => undefined,
        (error: unknown) => error,
      );
      if (primaryError === undefined) {
        expect(observedError).toBe(storeCloseError);
      } else {
        expect(observedError).toMatchObject({
          code: 'project_read_failed',
          cause: primaryError,
        });
      }
      expect(cleanupOrder).toEqual(['store', 'snapshot', 'anchor']);
      await expect(access(removedDirectory as string)).rejects.toMatchObject({ code: 'ENOENT' });
    }
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
