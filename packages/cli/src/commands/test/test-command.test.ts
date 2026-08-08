import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COMMAND_REQUEST_SCHEMA_VERSION,
  TEST_RESOURCE_SCHEMA_VERSION,
  cliResultSchema,
  type CommandRequest,
} from '@attest/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { loadProject } from '../../project/load-project.js';
import {
  fixtureAgent,
  candidateFromLoadedProject,
  writeFixtureProject,
} from '../../project/transaction/project-transaction.test-fixture.js';
import { prepareProjectCandidate } from '../../project/transaction/candidate-project.js';
import { prepareTransaction } from '../../project/transaction/transaction-journal.js';
import { createFileChanges } from '../../project/transaction/transactional-writer.js';
import { runCli, type CliIo } from '../../run-cli.js';
import { runTestMutationCommand } from './test-command.js';

const temporaryDirectories: string[] = [];

const createProject = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'attest-cli2-test-authoring-'));
  temporaryDirectories.push(root);
  await writeFixtureProject(root);
  return root;
};

const collectIo = (): { errors: string[]; io: CliIo; output: string[] } => {
  const errors: string[] = [];
  const output: string[] = [];
  return {
    errors,
    output,
    io: { error: (message) => errors.push(message), output: (message) => output.push(message) },
  };
};

const nonInteractive = (stdin = '') => ({
  ci: false,
  inputIsTTY: false,
  outputIsTTY: false,
  prompt: (): Promise<string> => Promise.reject(new Error('prompt must not be called')),
  readStdin: (): Promise<string> => Promise.resolve(stdin),
});

const runJson = async (
  root: string,
  argv: string[],
  stdin = '',
): Promise<{
  document: ReturnType<typeof cliResultSchema.parse>;
  exitCode: number;
  output: string;
}> => {
  const collected = collectIo();
  const exitCode = await runCli([...argv, '--output', 'json'], {
    interaction: nonInteractive(stdin),
    io: collected.io,
    workingDirectory: root,
  });
  expect(collected.errors).toEqual([]);
  expect(collected.output).toHaveLength(1);
  return {
    document: cliResultSchema.parse(JSON.parse(collected.output[0] ?? '{}') as unknown),
    exitCode,
    output: collected.output[0] ?? '',
  };
};

/** Captures every project byte using sorted project-relative names. */
const snapshotProject = async (root: string): Promise<Record<string, string>> => {
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string, prefix = ''): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path, relative);
      else snapshot[relative] = (await readFile(path)).toString('base64');
    }
  };
  await visit(root);
  return snapshot;
};

const addTestRequest = (id: string): Extract<CommandRequest, { command: 'test.add' }> => ({
  schema: COMMAND_REQUEST_SCHEMA_VERSION,
  command: 'test.add',
  test: {
    schema: TEST_RESOURCE_SCHEMA_VERSION,
    id,
    name: id,
    agent_id: fixtureAgent.id,
    cases: [],
    datasets: [],
    metrics: [],
  },
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('CLI2.7 test, case, and dataset authoring', { timeout: 20_000 }, () => {
  it('supports canonical test and direct-case happy paths in human and JSON modes', async () => {
    const root = await createProject();
    expect((await runJson(root, ['test', 'add', 'smoke', '--agent', 'support'])).exitCode).toBe(0);
    expect(
      (
        await runJson(root, [
          'test',
          'case',
          'add',
          'smoke',
          '--id',
          'ping',
          '--input',
          '{"question":"ping"}',
        ])
      ).exitCode,
    ).toBe(0);

    const listed = await runJson(root, ['test', 'case', 'list', 'smoke']);
    expect(listed.document).toMatchObject({
      ok: true,
      command: 'test.case.list',
      result: { test_id: 'smoke', items: [{ id: 'ping' }] },
    });
    expect((await runJson(root, ['test', 'case', 'show', 'smoke', 'ping'])).document).toMatchObject(
      {
        ok: true,
        result: { case: { id: 'ping', input: { question: 'ping' } } },
      },
    );
    expect(
      (await runJson(root, ['test', 'case', 'rename', 'smoke', 'ping', 'pong'])).exitCode,
    ).toBe(0);
    expect((await runJson(root, ['test', 'rename', 'smoke', 'smoke-v2'])).exitCode).toBe(0);
    expect(
      (await runJson(root, ['test', 'case', 'remove', 'smoke-v2', 'pong', '--yes'])).exitCode,
    ).toBe(0);
    expect((await runJson(root, ['test', 'remove', 'smoke-v2', '--yes'])).exitCode).toBe(0);
    expect((await loadProject({ project: root })).tests.map(({ id }) => id)).toEqual(['refund']);
  });

  it('validates the exact-one existing agent cross-reference before writing', async () => {
    const root = await createProject();
    const before = await snapshotProject(root);
    const response = await runJson(root, ['test', 'add', 'broken', '--agent', 'missing']);
    expect(response.exitCode).toBe(1);
    expect(response.document).toMatchObject({ ok: false, error: { code: 'project_invalid' } });
    expect(await snapshotProject(root)).toEqual(before);
  });

  it('keeps generated ids stable between direct cases, datasets, and dataset renames', async () => {
    const root = await createProject();
    const source = join(root, 'native.json');
    await writeFile(source, JSON.stringify([{ input: { prompt: 'same' }, expected: 'ok' }]));
    await runJson(root, ['test', 'add', 'direct', '--agent', 'support']);
    await runJson(root, ['test', 'add', 'dataset-owner', '--agent', 'support']);
    await runJson(root, ['test', 'case', 'import', 'direct', source]);
    await runJson(root, ['test', 'dataset', 'import', 'dataset-owner', source, '--as', 'native']);
    let loaded = await loadProject({ project: root });
    const directId = loaded.tests.find(({ id }) => id === 'direct')?.cases[0]?.id;
    expect(loaded.datasets.find(({ metadata }) => metadata.id === 'native')?.cases[0]?.id).toBe(
      directId,
    );

    await runJson(root, ['test', 'dataset', 'rename', 'native', 'native-v2']);
    loaded = await loadProject({ project: root });
    expect(loaded.datasets.find(({ metadata }) => metadata.id === 'native-v2')?.cases[0]?.id).toBe(
      directId,
    );
    expect(loaded.tests.find(({ id }) => id === 'dataset-owner')?.datasets[0]?.dataset_id).toBe(
      'native-v2',
    );
  });

  it('aggregates every collision across direct and attached cases', async () => {
    const root = await createProject();
    const source = join(root, 'collisions.jsonl');
    await writeFile(
      source,
      [
        JSON.stringify({ id: 'collision-one', input: 1 }),
        JSON.stringify({ id: 'collision-two', input: 2 }),
      ].join('\n'),
    );
    await runJson(root, ['test', 'add', 'holding', '--agent', 'support']);
    await runJson(root, ['test', 'dataset', 'import', 'holding', source, '--as', 'collisions']);
    for (const id of ['collision-one', 'collision-two']) {
      await runJson(root, ['test', 'case', 'add', 'refund', '--id', id, '--input', 'null']);
    }
    const before = await snapshotProject(root);
    const response = await runJson(root, ['test', 'dataset', 'attach', 'refund', 'collisions']);
    expect(response.exitCode).toBe(1);
    if (response.document.ok) throw new Error('Expected collision failure.');
    const details = response.document.error.details as { diagnostics?: unknown[] };
    expect(details.diagnostics).toHaveLength(2);
    expect(await snapshotProject(root)).toEqual(before);
  }, 15_000);

  it('creates, detaches, and reattaches datasets without copying rows', async () => {
    const root = await createProject();
    await runJson(root, ['test', 'dataset', 'add', 'refund', 'empty']);
    let loaded = await loadProject({ project: root });
    expect(loaded.datasets.find(({ metadata }) => metadata.id === 'empty')?.cases).toEqual([]);
    expect(loaded.tests[0]?.datasets.map(({ dataset_id }) => dataset_id)).toContain('empty');

    await runJson(root, ['test', 'dataset', 'detach', 'refund', 'empty']);
    await runJson(root, ['test', 'dataset', 'attach', 'refund', 'empty', '--tag', 'smoke']);
    loaded = await loadProject({ project: root });
    expect(loaded.tests[0]?.datasets.find(({ dataset_id }) => dataset_id === 'empty')).toEqual({
      dataset_id: 'empty',
      tags: ['smoke'],
    });
  });

  it('reports non-TTY missing input and rejects overlapping request sources', async () => {
    const root = await createProject();
    expect((await runJson(root, ['test', 'add', 'missing-agent'])).document).toMatchObject({
      ok: false,
      error: { code: 'cli_missing_input', path: '--agent' },
    });

    const requestPath = join(root, 'request.json');
    await writeFile(requestPath, JSON.stringify(addTestRequest('from-json')));
    const overlap = await runJson(root, [
      'test',
      'add',
      'flag-id',
      '--agent',
      'support',
      '--from-json',
      requestPath,
    ]);
    expect(overlap.exitCode).toBe(2);
    expect(overlap.document).toMatchObject({ ok: false, error: { code: 'cli_usage' } });
  });

  it('rolls back the complete transaction when publication fails', async () => {
    const root = await createProject();
    const before = await snapshotProject(root);
    await expect(
      runTestMutationCommand({
        project: root,
        publishObserver: () => {
          throw new Error('injected publication failure');
        },
        readStdin: () => Promise.resolve(''),
        request: addTestRequest('rollback'),
        workingDirectory: root,
      }),
    ).rejects.toMatchObject({ code: 'project_transaction_failed' });
    expect(await snapshotProject(root)).toEqual(before);
    expect((await loadProject({ project: root })).tests.some(({ id }) => id === 'rollback')).toBe(
      false,
    );
  });

  it('keeps dry runs byte-free and hash conflicts write-free', async () => {
    const root = await createProject();
    const loaded = await loadProject({ project: root });
    const interruptedCandidate = candidateFromLoadedProject(loaded);
    interruptedCandidate.tests.push(addTestRequest('interrupted').test);
    const preparedCandidate = prepareProjectCandidate(interruptedCandidate);
    await prepareTransaction(
      root,
      createFileChanges(loaded, preparedCandidate),
      loaded.projectHash,
      preparedCandidate.projectHash,
    );
    const before = await snapshotProject(root);
    const preview = await runJson(root, [
      'test',
      'add',
      'preview',
      '--agent',
      'support',
      '--dry-run',
      '--if-project-hash',
      loaded.projectHash,
    ]);
    expect(preview.document).toMatchObject({
      ok: true,
      result: { committed: false, dry_run: true },
    });
    expect(await snapshotProject(root)).toEqual(before);

    const conflictRoot = await createProject();
    const conflictBefore = await snapshotProject(conflictRoot);
    const conflict = await runJson(conflictRoot, [
      'test',
      'add',
      'conflict',
      '--agent',
      'support',
      '--if-project-hash',
      'a'.repeat(64),
    ]);
    expect(conflict.exitCode).toBe(3);
    expect(conflict.document).toMatchObject({ ok: false, error: { code: 'project_changed' } });
    expect(await snapshotProject(conflictRoot)).toEqual(conflictBefore);
  });

  it('publishes versioned machine help and schema metadata for the native import surface', async () => {
    const root = await createProject();
    const help = await runJson(root, ['help', 'test', 'case', 'import']);
    expect(help.document).toMatchObject({
      ok: true,
      command: 'help',
      result: {
        command: {
          path: ['test', 'case', 'import'],
          request_schema: COMMAND_REQUEST_SCHEMA_VERSION,
        },
      },
    });
    expect(help.output).toContain('jsonl');
    expect(help.output).not.toContain('csv');

    const schema = await runJson(root, ['schema', 'print', COMMAND_REQUEST_SCHEMA_VERSION]);
    expect(schema.document).toMatchObject({ ok: true, command: 'schema.print' });
    expect(schema.output).toContain('test.dataset.add');
    expect(schema.output).not.toContain('test.dataset.create');
    expect(schema.output).toContain('test.case.rename');
  });

  it('serializes repeated human and JSON dry runs deterministically', async () => {
    const root = await createProject();
    const first = await runJson(root, [
      'test',
      'add',
      'deterministic',
      '--agent',
      'support',
      '--dry-run',
    ]);
    const second = await runJson(root, [
      'test',
      'add',
      'deterministic',
      '--agent',
      'support',
      '--dry-run',
    ]);
    expect(second.output).toBe(first.output);

    const firstHuman = collectIo();
    const secondHuman = collectIo();
    for (const io of [firstHuman.io, secondHuman.io]) {
      expect(
        await runCli(['test', 'add', 'deterministic', '--agent', 'support', '--dry-run'], {
          interaction: nonInteractive(),
          io,
          workingDirectory: root,
        }),
      ).toBe(0);
    }
    expect(secondHuman.output).toEqual(firstHuman.output);
  });

  it('keeps request paths, authored secrets, and absolute import paths out of results', async () => {
    const root = await createProject();
    const secret = 'super-secret-auth-token';
    const requestPath = join(root, 'private', 'request-with-secret.json');
    await mkdir(join(root, 'private'));
    await writeFile(requestPath, `{not-json:${secret}}`);
    const invalidRequest = await runJson(root, ['test', 'add', '--from-json', requestPath]);
    expect(invalidRequest.output).not.toContain(secret);
    expect(invalidRequest.output).not.toContain(requestPath);

    const casesPath = join(root, 'private', 'native-cases.jsonl');
    await writeFile(casesPath, JSON.stringify({ input: { value: 'safe' } }));
    await runJson(root, ['test', 'add', 'owner', '--agent', 'support']);
    const imported = await runJson(root, [
      'test',
      'dataset',
      'import',
      'owner',
      casesPath,
      '--as',
      'safe-data',
    ]);
    expect(imported.output).not.toContain(casesPath);
    const loaded = await loadProject({ project: root });
    expect(
      JSON.stringify(loaded.datasets.find(({ metadata }) => metadata.id === 'safe-data')),
    ).not.toContain(casesPath);
  });

  it('supports stdin and --from-json parity while rejecting generalized import options', async () => {
    const root = await createProject();
    const request = JSON.stringify(addTestRequest('stdin-test'));
    expect(
      (await runJson(root, ['test', 'add', '--from-json', '-'], request)).document,
    ).toMatchObject({ ok: true, command: 'test.add' });

    const cases = `${JSON.stringify({ input: 'one' })}\n${JSON.stringify({ input: 'two' })}\n`;
    expect(
      (
        await runJson(
          root,
          ['test', 'case', 'import', 'stdin-test', '-', '--format', 'jsonl'],
          cases,
        )
      ).document,
    ).toMatchObject({ ok: true, result: { imported_case_count: 2 } });

    const mappedRequest = {
      schema: COMMAND_REQUEST_SCHEMA_VERSION,
      command: 'test.case.import',
      test_id: 'stdin-test',
      source: '-',
      import: {
        format: 'csv',
        mapping: [{ destination: 'input', source: 'prompt' }],
      },
    };
    const path = join(root, 'mapped-request.json');
    await writeFile(path, JSON.stringify(mappedRequest));
    const rejected = await runJson(root, ['test', 'case', 'import', '--from-json', path]);
    expect(rejected.exitCode).toBe(2);
    expect(rejected.document).toMatchObject({ ok: false, error: { code: 'cli_usage' } });
  });
});
