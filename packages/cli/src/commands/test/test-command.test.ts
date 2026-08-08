import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COMMAND_REQUEST_SCHEMA_VERSION,
  TEST_RESOURCE_SCHEMA_VERSION,
  cliResultSchema,
  type CommandRequest,
  type DatasetResource,
  type ProjectManifest,
} from '@attest/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { hashCanonicalJson } from '../../project/canonical-project.js';
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

const runHuman = async (root: string, argv: string[], stdin = ''): Promise<string> => {
  const collected = collectIo();
  const exitCode = await runCli(argv, {
    interaction: nonInteractive(stdin),
    io: collected.io,
    workingDirectory: root,
  });
  expect(exitCode).toBe(0);
  expect(collected.errors).toEqual([]);
  expect(collected.output).toHaveLength(1);
  return collected.output[0] ?? '';
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

describe('CLI2.7/CLI2.8 test, case, dataset, and import authoring', { timeout: 20_000 }, () => {
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
        readImportStdin: async function* readImportStdin() {
          await Promise.resolve();
          yield '';
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

  it('publishes versioned machine help and schema metadata for the tabular import surface', async () => {
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
    expect(help.output).toContain('csv');
    expect(help.output).toContain('records-pointer');
    expect(help.output).toContain('on-conflict');
    if (!help.document.ok) throw new Error('Expected structured import help.');
    const importHelp = (
      help.document.result as {
        command: {
          constraints: string[];
          examples: string[];
          options: Array<{ default: unknown; name: string; repeatable: boolean }>;
        };
      }
    ).command;
    expect(importHelp.options.find(({ name }) => name === 'map')).toMatchObject({
      repeatable: true,
    });
    expect(importHelp.options.find(({ name }) => name === 'parse-json')).toMatchObject({
      repeatable: true,
    });
    expect(importHelp.options.find(({ name }) => name === 'sync')).toMatchObject({
      default: 'append',
    });
    expect(importHelp.options.find(({ name }) => name === 'on-conflict')).toMatchObject({
      default: 'error',
    });
    expect(
      importHelp.examples.some((example) => example.includes('attest.command-request/v2')),
    ).toBe(true);
    const caseRequestExample = importHelp.examples.find((example) =>
      example.includes('test case import --from-json - --output json'),
    );
    expect(caseRequestExample).not.toContain("--from-json '{");
    const caseRequest = caseRequestExample?.match(
      /^printf '%s\\n' '(.+)' \| attest test case import --from-json - --output json$/u,
    )?.[1];
    expect(caseRequest).toBeDefined();
    if (caseRequest === undefined) throw new Error('Expected executable case request example.');
    expect(importHelp.constraints).toContain(
      'upsert requires an explicit mapped id or --key source.',
    );

    await runJson(root, ['test', 'add', 'smoke', '--agent', 'support']);
    await writeFile(join(root, 'cases.csv'), 'prompt\nhelp-case\n');
    const caseImport = await runJson(
      root,
      ['test', 'case', 'import', '--from-json', '-'],
      caseRequest,
    );
    expect(caseImport.document).toMatchObject({ ok: true, command: 'test.case.import' });

    const datasetHelp = await runJson(root, ['help', 'test', 'dataset', 'import']);
    if (!datasetHelp.document.ok) throw new Error('Expected structured dataset import help.');
    const datasetRequestExample = (
      datasetHelp.document.result as { command: { examples: string[] } }
    ).command.examples.find((example) =>
      example.includes('test dataset import --from-json - --output json'),
    );
    expect(datasetRequestExample).not.toContain("--from-json '{");
    const datasetRequest = datasetRequestExample?.match(
      /^printf '%s\\n' '(.+)' \| attest test dataset import --from-json - --output json$/u,
    )?.[1];
    expect(datasetRequest).toBeDefined();
    if (datasetRequest === undefined) {
      throw new Error('Expected executable dataset request example.');
    }
    await writeFile(join(root, 'cases.jsonl'), '{"prompt":"help-dataset"}\n');
    const datasetImport = await runJson(
      root,
      ['test', 'dataset', 'import', '--from-json', '-'],
      datasetRequest,
    );
    expect(datasetImport.document).toMatchObject({ ok: true, command: 'test.dataset.import' });

    const datasetAddHelp = await runJson(root, ['help', 'test', 'dataset', 'add']);
    expect(datasetAddHelp.document).toMatchObject({
      ok: true,
      result: {
        command: {
          path: ['test', 'dataset', 'add'],
          request_schema: COMMAND_REQUEST_SCHEMA_VERSION,
        },
      },
    });
    const datasetCreateHelp = await runJson(root, ['help', 'test', 'dataset', 'create']);
    expect(datasetCreateHelp).toMatchObject({
      exitCode: 2,
      document: { ok: false, error: { code: 'cli_usage' } },
    });

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

  it('keeps import results deterministic while manifest integrity binds the real timestamp', async () => {
    const root = await createProject();
    const source = join(root, 'deterministic-import.jsonl');
    await writeFile(source, JSON.stringify({ input: { prompt: 'same bytes' } }));
    const argv = [
      'test',
      'dataset',
      'import',
      'refund',
      source,
      '--as',
      'stable-import',
      '--dry-run',
    ];
    const first = await runJson(root, argv);
    const second = await runJson(root, argv);
    expect(second.output).toBe(first.output);
    if (!first.document.ok) throw new Error('Expected dataset import preview.');

    const human = collectIo();
    expect(
      await runCli(argv, {
        interaction: nonInteractive(),
        io: human.io,
        workingDirectory: root,
      }),
    ).toBe(0);
    expect(human.output.join('\n')).toContain('Semantic diff:');
    expect(human.output.join('\n')).toContain('add dataset stable-import');
    expect(human.output.join('\n')).toContain('reference added: dataset stable-import');
    expect(human.output.join('\n')).toContain('remove `--dry-run`');

    const beforeCommit = Date.now();
    const committed = await runJson(
      root,
      argv.filter((argument) => argument !== '--dry-run'),
    );
    const afterCommit = Date.now();
    if (!committed.document.ok) throw new Error('Expected dataset import commit.');
    expect(committed.document).toMatchObject({
      ok: true,
      project_hash_after: first.document.project_hash_after,
      result: { operations: (first.document.result as { operations: unknown[] }).operations },
    });
    const loaded = await loadProject({ project: root });
    const importedAt = loaded.datasets.find(({ metadata }) => metadata.id === 'stable-import')
      ?.metadata.provenance?.imported_at;
    expect(importedAt).toBeDefined();
    expect(Date.parse(importedAt ?? '')).toBeGreaterThanOrEqual(beforeCommit);
    expect(Date.parse(importedAt ?? '')).toBeLessThanOrEqual(afterCommit);
    expect(loaded.datasets).toHaveLength(2);

    const metadataPath = join(root, 'attest/datasets/stable-import.meta.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as DatasetResource;
    const manifest = JSON.parse(
      await readFile(join(root, 'attest.project.json'), 'utf8'),
    ) as ProjectManifest;
    expect(
      manifest.resources.datasets.find(({ id }) => id === 'stable-import')?.metadata_content_hash,
    ).toBe(hashCanonicalJson(metadata));
    if (metadata.provenance === undefined) throw new Error('Expected import provenance.');
    metadata.provenance.imported_at = '2001-02-03T04:05:06.000Z';
    await writeFile(metadataPath, `${JSON.stringify(metadata, undefined, 2)}\n`);

    const validation = await runJson(root, ['project', 'validate']);
    expect(validation.exitCode).toBe(1);
    if (validation.document.ok) throw new Error('Expected metadata integrity failure.');
    const diagnostics = (
      validation.document.error.details as {
        diagnostics: Array<{ code: string; message: string; source: string }>;
      }
    ).diagnostics;
    const integrityDiagnostic = diagnostics.find(
      ({ code, source }) =>
        code === 'content_hash_mismatch' && source === 'attest/datasets/stable-import.meta.json',
    );
    expect(integrityDiagnostic).toMatchObject({
      code: 'content_hash_mismatch',
      source: 'attest/datasets/stable-import.meta.json',
    });
    expect(integrityDiagnostic?.message).toContain('canonical SHA-256');
  });

  it('provides redacted human/JSON dry-run parity and import-specific optimistic conflicts', async () => {
    const root = await createProject();
    await runJson(root, ['test', 'add', 'mapped', '--agent', 'support']);
    await runJson(root, [
      'test',
      'case',
      'add',
      'mapped',
      '--id',
      'absent-source',
      '--input',
      '"preserved"',
    ]);
    const source = join(root, 'mapped.csv');
    await writeFile(source, 'external_id,prompt,tags\none,hello,"[""smoke""]"\n');
    const loaded = await loadProject({ project: root });
    const command = [
      'test',
      'case',
      'import',
      'mapped',
      source,
      '--map',
      'input.question=prompt',
      '--map',
      'tags=tags',
      '--parse-json',
      'tags',
      '--key',
      'external_id',
      '--sync',
      'upsert',
      '--dry-run',
      '--if-project-hash',
      loaded.projectHash,
    ];
    const before = await snapshotProject(root);
    const json = await runJson(root, command);
    expect(json.document).toMatchObject({
      ok: true,
      result: {
        committed: false,
        import: {
          counts: { inserted: 1, read: 1, skipped: 0, updated: 0 },
          preview: [
            {
              input: { question: '<redacted:string>' },
              tags: ['<redacted:string>'],
            },
          ],
        },
      },
    });
    const generatedId = json.document.ok
      ? ((json.document.result as { import: { preview: Array<{ id: string }> } }).import.preview[0]
          ?.id ?? '')
      : '';
    const human = await runHuman(root, command);
    expect(human).toContain('Import: read 1, inserted 1, updated 0, skipped 0.');
    expect(human).toContain(generatedId);
    expect(human).toContain('<redacted:string>');
    expect(await snapshotProject(root)).toEqual(before);

    const conflict = await runJson(root, [
      ...command.slice(0, -3),
      '--if-project-hash',
      'a'.repeat(64),
    ]);
    expect(conflict).toMatchObject({
      exitCode: 3,
      document: { ok: false, error: { code: 'project_changed' } },
    });
    expect(await snapshotProject(root)).toEqual(before);
  });

  it('upserts existing keyed datasets in order and never deletes rows absent from the source', async () => {
    const root = await createProject();
    await runJson(root, ['test', 'add', 'dataset-upsert', '--agent', 'support']);
    const source = join(root, 'incremental.csv');
    const baseCommand = [
      'test',
      'dataset',
      'import',
      'dataset-upsert',
      source,
      '--as',
      'incremental',
      '--map',
      'input=prompt',
      '--key',
      'external_id',
      '--sync',
      'upsert',
    ];
    await writeFile(source, 'external_id,prompt\none,old\ntwo,preserved\n');
    expect((await runJson(root, baseCommand)).exitCode).toBe(0);
    const first = await loadProject({ project: root });
    const initialCases = first.datasets.find(
      ({ metadata }) => metadata.id === 'incremental',
    )!.cases;

    await writeFile(source, 'external_id,prompt\none,new\nthree,added\n');
    const updated = await runJson(root, baseCommand);
    expect(updated.document).toMatchObject({
      ok: true,
      result: {
        import: { counts: { inserted: 1, read: 2, skipped: 0, updated: 1 } },
      },
    });
    const loaded = await loadProject({ project: root });
    const dataset = loaded.datasets.find(({ metadata }) => metadata.id === 'incremental')!;
    expect(dataset.cases).toEqual([
      { id: initialCases[0]!.id, input: 'new' },
      initialCases[1],
      expect.objectContaining({ input: 'added' }),
    ]);
    expect(dataset.metadata.provenance).toMatchObject({
      source_type: 'csv',
      key_field: 'external_id',
      mapping: [{ destination: 'input', source: 'prompt' }],
      counts: { inserted: 1, read: 2, skipped: 0, updated: 1 },
    });
    expect(JSON.stringify(dataset.metadata.provenance)).not.toContain(source);
  });

  it('rejects direct imports colliding with attached cases before any project write', async () => {
    const root = await createProject();
    await runJson(root, ['test', 'add', 'collision-target', '--agent', 'support']);
    const datasetSource = join(root, 'attached.jsonl');
    await writeFile(datasetSource, '{"id":"attached-id","input":"dataset"}\n');
    await runJson(root, [
      'test',
      'dataset',
      'import',
      'collision-target',
      datasetSource,
      '--as',
      'attached',
    ]);
    const directSource = join(root, 'direct.json');
    await writeFile(directSource, '[{"id":"attached-id","input":"direct"}]');
    const before = await snapshotProject(root);
    const collision = await runJson(root, [
      'test',
      'case',
      'import',
      'collision-target',
      directSource,
    ]);
    expect(collision).toMatchObject({
      exitCode: 1,
      document: {
        ok: false,
        error: {
          code: 'project_invalid',
          details: { diagnostics: [{ code: 'resolved_case_collision' }] },
        },
      },
    });
    expect(await snapshotProject(root)).toEqual(before);
  });

  it('aggregates every JSON and JSONL record error with physical source locations', async () => {
    const root = await createProject();
    const jsonlSource = join(root, 'invalid-cases.jsonl');
    await writeFile(
      jsonlSource,
      [
        'not-json',
        '',
        '{"input":"ok","extra":true,"slash/key":true,"tilde~key":true}',
        '{"expected":"missing-input"}',
      ].join('\n'),
    );
    const jsonlBefore = await snapshotProject(root);
    const jsonl = await runJson(root, ['test', 'case', 'import', 'refund', jsonlSource]);
    expect(jsonl.exitCode).toBe(1);
    if (jsonl.document.ok) throw new Error('Expected JSONL validation failure.');
    const jsonlDetails = jsonl.document.error.details as { diagnostics: unknown[] };
    const jsonlDiagnostics = jsonlDetails.diagnostics as Array<{
      code: string;
      destination_path: string;
      hint: string;
      line: number;
      source_field: string;
    }>;
    expect(jsonlDiagnostics.map(({ line }) => line)).toEqual([1, 3, 3, 3, 4]);
    expect(jsonlDiagnostics.every(({ code, hint }) => code.length > 0 && hint.length > 0)).toBe(
      true,
    );
    expect(jsonlDiagnostics.map(({ destination_path }) => destination_path)).toEqual([
      '',
      '/extra',
      '/slash~1key',
      '/tilde~0key',
      '/input',
    ]);
    expect(jsonlDiagnostics.map(({ source_field }) => source_field)).toEqual([
      '<line>',
      '/extra',
      '/slash~1key',
      '/tilde~0key',
      '/input',
    ]);
    expect(await snapshotProject(root)).toEqual(jsonlBefore);

    const jsonSource = join(root, 'invalid-cases.json');
    await writeFile(
      jsonSource,
      JSON.stringify([{ input: 'ok', extra: true }, { expected: 'missing-input' }]),
    );
    const json = await runJson(root, ['test', 'case', 'import', 'refund', jsonSource]);
    expect(json.exitCode).toBe(1);
    if (json.document.ok) throw new Error('Expected JSON validation failure.');
    const jsonDetails = json.document.error.details as { diagnostics: unknown[] };
    const jsonDiagnostics = jsonDetails.diagnostics as Array<{ row: number }>;
    expect(jsonDiagnostics.map(({ row }) => row)).toEqual([1, 2]);
  });

  it('supports global common flags before the namespace with structured errors', async () => {
    const root = await createProject();
    const collected = collectIo();
    expect(
      await runCli(['--output', 'json', '--non-interactive', 'test', 'list'], {
        interaction: nonInteractive(),
        io: collected.io,
        workingDirectory: root,
      }),
    ).toBe(0);
    expect(collected.errors).toEqual([]);
    expect(cliResultSchema.parse(JSON.parse(collected.output[0] ?? '{}'))).toMatchObject({
      ok: true,
      command: 'test.list',
    });

    const missing = collectIo();
    expect(
      await runCli(['--output=json', 'test', 'dataset', 'attach', 'refund', 'absent'], {
        interaction: nonInteractive(),
        io: missing.io,
        workingDirectory: root,
      }),
    ).toBe(1);
    expect(cliResultSchema.parse(JSON.parse(missing.output[0] ?? '{}'))).toMatchObject({
      ok: false,
      command: 'test.dataset.attach',
      error: { hint: 'Run `attest list datasets` to inspect available ids.' },
    });
  });

  it('previews removals without confirmation and treats a guided no as a clean no-op', async () => {
    const root = await createProject();
    const before = await snapshotProject(root);
    const preview = await runJson(root, ['test', 'remove', 'refund', '--dry-run']);
    expect(preview).toMatchObject({
      exitCode: 0,
      document: { ok: true, result: { committed: false, dry_run: true } },
    });
    expect(await snapshotProject(root)).toEqual(before);

    const declined = collectIo();
    expect(
      await runCli(['test', 'remove', 'refund'], {
        interaction: {
          ci: false,
          inputIsTTY: true,
          outputIsTTY: true,
          prompt: () => Promise.resolve('n'),
          readStdin: () => Promise.resolve(''),
        },
        io: declined.io,
        workingDirectory: root,
      }),
    ).toBe(0);
    expect(declined.errors).toEqual([]);
    expect(declined.output).toEqual(['No changes made; test refund was not removed.']);
    expect(await snapshotProject(root)).toEqual(before);
  });

  it('reports attached dataset blockers before prompting with exact detach commands', async () => {
    const root = await createProject();
    const collected = collectIo();
    let promptCount = 0;
    expect(
      await runCli(['test', 'dataset', 'remove', 'refunds'], {
        interaction: {
          ci: false,
          inputIsTTY: true,
          outputIsTTY: true,
          prompt: () => {
            promptCount += 1;
            return Promise.resolve('yes');
          },
          readStdin: () => Promise.resolve(''),
        },
        io: collected.io,
        workingDirectory: root,
      }),
    ).toBe(1);
    expect(promptCount).toBe(0);
    expect(collected.errors.join('\n')).toContain('attest test dataset detach refund refunds');
  });

  it('diffs direct-case removals by stable case id instead of shifted positions', async () => {
    const root = await createProject();
    for (const id of ['case-one', 'case-two', 'case-three', 'case-four']) {
      await runJson(root, ['test', 'case', 'add', 'refund', '--id', id, '--input', `"${id}"`]);
    }
    const preview = await runJson(root, [
      'test',
      'case',
      'remove',
      'refund',
      'case-one',
      '--dry-run',
    ]);
    expect(preview.exitCode).toBe(0);
    if (!preview.document.ok) throw new Error('Expected case removal preview.');
    const result = preview.document.result as { operations: unknown[] };
    const operations = result.operations as Array<{
      changes: Array<{ change: string; path: string }>;
      resource: { id: string; type: string };
    }>;
    const testUpdate = operations.find(
      ({ resource }) => resource.type === 'test' && resource.id === 'refund',
    );
    expect(testUpdate?.changes).toContainEqual({ change: 'remove', path: '/cases/case-one' });
    expect(testUpdate?.changes.some(({ path }) => /^\/cases\/\d/u.test(path))).toBe(false);
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

  it('supports stdin and --from-json parity for generalized import options', async () => {
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
    const imported = await runJson(
      root,
      ['test', 'case', 'import', '--from-json', path],
      'prompt\nmapped\n',
    );
    expect(imported.exitCode).toBe(0);
    expect(imported.document).toMatchObject({
      ok: true,
      result: {
        imported_case_count: 1,
        import: { format: 'csv', counts: { inserted: 1, read: 1 } },
      },
    });
  });

  it('rejects malformed UTF-8 and byte-limit stdin before any project write', async () => {
    const root = await createProject();
    const before = await snapshotProject(root);
    const invalid = collectIo();
    expect(
      await runCli(
        ['test', 'case', 'import', 'refund', '-', '--format', 'jsonl', '--output', 'json'],
        {
          interaction: {
            ...nonInteractive(),
            readImportStdin: async function* readInvalidStdin() {
              await Promise.resolve();
              yield new Uint8Array([123, 34, 105, 110, 112, 117, 116, 34, 58, 34, 255, 34, 125]);
            },
          },
          io: invalid.io,
          workingDirectory: root,
        },
      ),
    ).toBe(1);
    expect(invalid.output.join('\n')).toContain('invalid_utf8');
    expect(await snapshotProject(root)).toEqual(before);

    let consumedPastLimit = false;
    const oversized = collectIo();
    expect(
      await runCli(
        ['test', 'case', 'import', 'refund', '-', '--format', 'jsonl', '--output', 'json'],
        {
          interaction: {
            ...nonInteractive(),
            readImportStdin: async function* readOversizedStdin() {
              await Promise.resolve();
              yield new Uint8Array(6 * 1024 * 1024);
              yield new Uint8Array(6 * 1024 * 1024);
              consumedPastLimit = true;
              yield new Uint8Array([1]);
            },
          },
          io: oversized.io,
          workingDirectory: root,
        },
      ),
    ).toBe(1);
    expect(oversized.output.join('\n')).toContain('import_size_limit');
    expect(consumedPastLimit).toBe(false);
    expect(await snapshotProject(root)).toEqual(before);
  });

  it('shows redacted aggregate diagnostics in human mode', async () => {
    const root = await createProject();
    const source = join(root, 'invalid-private.csv');
    await writeFile(source, 'parameters,secret\nnot-an-array,private-prompt\n');
    const collected = collectIo();
    expect(
      await runCli(['test', 'case', 'import', 'refund', source, '--map', 'tags=parameters'], {
        interaction: nonInteractive(),
        io: collected.io,
        workingDirectory: root,
      }),
    ).toBe(1);
    const rendered = collected.errors.join('\n');
    expect(rendered).toContain('row 2, source parameters, destination /tags');
    expect(rendered).toContain('invalid_type');
    expect(rendered).not.toContain('private-prompt');
  });

  it('honors target attachment tags when checking dataset import collisions', async () => {
    const root = await createProject();
    await runJson(root, ['test', 'add', 'filtered-target', '--agent', 'support']);
    await runJson(root, [
      'test',
      'case',
      'add',
      'filtered-target',
      '--id',
      'collision-id',
      '--input',
      '"direct"',
    ]);
    await runJson(root, ['test', 'dataset', 'add', 'filtered-target', 'filtered']);
    await runJson(root, ['test', 'dataset', 'detach', 'filtered-target', 'filtered']);
    await runJson(root, [
      'test',
      'dataset',
      'attach',
      'filtered-target',
      'filtered',
      '--tag',
      'billing',
    ]);
    const source = join(root, 'filtered.json');
    await writeFile(source, '[{"id":"collision-id","input":"dataset","tags":["support"]}]');
    const imported = await runJson(root, [
      'test',
      'dataset',
      'import',
      'filtered-target',
      source,
      '--as',
      'filtered',
      '--sync',
      'upsert',
    ]);
    expect(imported).toMatchObject({ exitCode: 0, document: { ok: true } });
  });

  it('reports retained import counts and addressable dedupe decisions', async () => {
    const root = await createProject();
    const source = join(root, 'dedupe.jsonl');
    await writeFile(source, '{"id":"first","input":"same"}\n{"id":"second","input":"same"}\n');
    const imported = await runJson(root, [
      'test',
      'case',
      'import',
      'refund',
      source,
      '--dedupe',
      'content',
    ]);
    expect(imported.document).toMatchObject({
      ok: true,
      result: {
        imported_case_count: 1,
        import: {
          counts: { inserted: 1, read: 2, skipped: 1, updated: 0 },
          decisions: [
            { action: 'skip', case_id: 'first', line: 2, matched_by: 'content' },
            { action: 'insert', case_id: 'first' },
          ],
        },
      },
    });
  });

  it('previews guided imports, defaults confirmation to no, and lets --yes bypass prompts', async () => {
    const root = await createProject();
    await runJson(root, ['test', 'add', 'guided', '--agent', 'support']);
    const source = join(root, 'guided.csv');
    await writeFile(source, 'prompt\nhello\n');
    const before = await snapshotProject(root);
    const declined = collectIo();
    const answers = ['', ''];
    expect(
      await runCli(['test', 'case', 'import', 'guided', source], {
        interaction: {
          ...nonInteractive(),
          inputIsTTY: true,
          outputIsTTY: true,
          prompt: () => Promise.resolve(answers.shift() ?? ''),
        },
        io: declined.io,
        workingDirectory: root,
      }),
    ).toBe(0);
    expect(declined.output.join('\n')).toContain('Redacted normalized preview');
    expect(declined.output).toContain('No changes made; import was not applied.');
    expect(await snapshotProject(root)).toEqual(before);

    let promptCount = 0;
    const accepted = collectIo();
    expect(
      await runCli(['test', 'case', 'import', 'guided', source, '--map', 'input=prompt', '--yes'], {
        interaction: {
          ...nonInteractive(),
          inputIsTTY: true,
          outputIsTTY: true,
          prompt: () => {
            promptCount += 1;
            return Promise.resolve('no');
          },
        },
        io: accepted.io,
        workingDirectory: root,
      }),
    ).toBe(0);
    expect(promptCount).toBe(0);
    expect(
      (await loadProject({ project: root })).tests.find(({ id }) => id === 'guided')?.cases,
    ).toHaveLength(1);
  });

  it('refuses silent shared dataset updates until previewed and explicitly confirmed', async () => {
    const root = await createProject();
    await runJson(root, ['test', 'add', 'shared-owner', '--agent', 'support']);
    await runJson(root, ['test', 'add', 'shared-reader', '--agent', 'support']);
    await runJson(root, ['test', 'dataset', 'add', 'shared-owner', 'shared']);
    await runJson(root, ['test', 'dataset', 'attach', 'shared-reader', 'shared']);
    const source = join(root, 'shared.jsonl');
    await writeFile(source, '{"id":"shared-case","input":"value"}\n');
    const before = await snapshotProject(root);

    const implicit = await runJson(root, [
      'test',
      'dataset',
      'import',
      'shared-owner',
      source,
      '--as',
      'shared',
    ]);
    expect(implicit.document).toMatchObject({ ok: false, error: { code: 'project_invalid' } });
    const refused = await runJson(root, [
      'test',
      'dataset',
      'import',
      'shared-owner',
      source,
      '--as',
      'shared',
      '--sync',
      'upsert',
    ]);
    expect(refused.document).toMatchObject({
      ok: false,
      error: {
        code: 'cli_missing_input',
        details: { affected_tests: ['shared-owner', 'shared-reader'] },
      },
    });
    expect(await snapshotProject(root)).toEqual(before);

    const preview = await runJson(root, [
      'test',
      'dataset',
      'import',
      'shared-owner',
      source,
      '--as',
      'shared',
      '--sync',
      'upsert',
      '--dry-run',
    ]);
    expect(preview.document).toMatchObject({
      ok: true,
      result: {
        affected_tests: ['shared-owner', 'shared-reader'],
        committed: false,
      },
    });
    const confirmed = await runJson(root, [
      'test',
      'dataset',
      'import',
      'shared-owner',
      source,
      '--as',
      'shared',
      '--sync',
      'upsert',
      '--yes',
    ]);
    expect(confirmed.document).toMatchObject({
      ok: true,
      result: {
        affected_tests: ['shared-owner', 'shared-reader'],
        committed: true,
        shared_dataset_preview: {
          affected_tests: ['shared-owner', 'shared-reader'],
          import: { format: 'jsonl' },
        },
      },
    });
    if (!confirmed.document.ok) throw new Error('Expected confirmed shared dataset update.');
    const sharedPreview = (
      confirmed.document.result as {
        shared_dataset_preview: { operations: unknown; project_hash_before: unknown };
      }
    ).shared_dataset_preview;
    expect(Array.isArray(sharedPreview.operations)).toBe(true);
    expect(typeof sharedPreview.project_hash_before).toBe('string');

    await writeFile(source, '{"id":"shared-case","input":"human-update"}\n');
    const human = await runHuman(root, [
      'test',
      'dataset',
      'import',
      'shared-owner',
      source,
      '--as',
      'shared',
      '--sync',
      'upsert',
      '--yes',
    ]);
    expect(human).toContain('Shared dataset update preview:');
    expect(human).toContain('Dry run: would update dataset shared.');
    expect(human).toContain('Affected consumer tests: shared-owner, shared-reader.');
    expect(human).toContain('Confirmed shared dataset update:');

    await runJson(root, ['test', 'add', 'shared-new', '--agent', 'support']);
    await writeFile(source, '{"id":"shared-case","input":"new-consumer-update"}\n');
    const newConsumer = await runJson(root, [
      'test',
      'dataset',
      'import',
      'shared-new',
      source,
      '--as',
      'shared',
      '--sync',
      'upsert',
      '--yes',
    ]);
    expect(newConsumer.document).toMatchObject({
      ok: true,
      result: {
        affected_tests: ['shared-new', 'shared-owner', 'shared-reader'],
        shared_dataset_preview: {
          affected_tests: ['shared-new', 'shared-owner', 'shared-reader'],
        },
      },
    });
  });

  it('rejects non-empty or provenance-bearing dataset add requests before writing', async () => {
    const root = await createProject();
    const before = await snapshotProject(root);
    const emptyDataset = {
      schema: 'attest.dataset/v2',
      case_schema: 'attest.case/v2',
      id: 'new-data',
      name: 'New data',
      case_count: 0,
    };
    const base = {
      schema: COMMAND_REQUEST_SCHEMA_VERSION,
      command: 'test.dataset.add',
      test_id: 'refund',
    };
    const requests = [
      { ...base, dataset: { ...emptyDataset, case_count: 1 } },
      {
        ...base,
        dataset: {
          ...emptyDataset,
          provenance: {
            source_type: 'csv',
            mapping: [{ source: 'prompt', destination: 'input' }],
            imported_at: '2026-08-08T00:00:00.000Z',
            source_content_hash: 'a'.repeat(64),
            counts: { read: 0, inserted: 0, updated: 0, skipped: 0 },
          },
        },
      },
    ];

    for (const [index, request] of requests.entries()) {
      const path = join(root, `invalid-dataset-add-${index}.json`);
      await writeFile(path, JSON.stringify(request));
      const rejected = await runJson(root, ['test', 'dataset', 'add', '--from-json', path]);
      expect(rejected).toMatchObject({
        exitCode: 2,
        document: { ok: false, error: { code: 'cli_usage' } },
      });
    }
    const after = await snapshotProject(root);
    expect(
      Object.fromEntries(Object.entries(after).filter(([path]) => !path.startsWith('invalid-'))),
    ).toEqual(before);
  });
});
