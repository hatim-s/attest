import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CASE_SCHEMA_ID,
  COMMAND_REQUEST_SCHEMA_ID,
  DATASET_SCHEMA_ID,
  TEST_RESOURCE_SCHEMA_ID,
  datasetResourceSchema,
  projectManifestSchema,
} from '@attest/contracts';
import { contentHash } from '@attest/core';
import { describe, expect, it, onTestFinished } from 'vitest';

import { LocalError } from '../../../errors/index.js';
import { writeFixtureProject } from '../../../_tests_/support/project-transaction.js';
import { loadProject } from '../../../project/project-loader/index.js';
import { readCommandRequest } from '../../shared/command-request.js';
import type { TestAuthoringCommand } from '../test-mutation-build.js';
import { runTestMutationCommand } from '../test-mutation-command.js';

const schema = COMMAND_REQUEST_SCHEMA_ID;

const createProject = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'attest-test-mutation-'));
  onTestFinished(() => rm(root, { force: true, recursive: true }));
  await writeFixtureProject(root);
  return root;
};

/** Reads every project file so a rejected mutation can be proven write-free. */
const snapshotProject = async (root: string): Promise<Record<string, string>> => {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const snapshot: Record<string, string> = {};
  for (const entry of entries.filter((item) => item.isFile())) {
    const path = join(entry.parentPath, entry.name);
    snapshot[path] = await readFile(path, 'base64');
  }
  return snapshot;
};

const writeSource = async (root: string, name: string, contents: string): Promise<string> => {
  const path = join(root, name);
  await writeFile(path, contents);
  return path;
};

const mutate = (root: string, request: TestAuthoringCommand) =>
  runTestMutationCommand({
    project: root,
    readImportStdin: () => {
      throw new Error('stdin must not be read');
    },
    readStdin: () => Promise.reject(new Error('stdin must not be read')),
    request,
    workingDirectory: root,
  });

const addTest = (root: string, id: string) =>
  mutate(root, {
    schema,
    command: 'test.add',
    test: {
      schema: TEST_RESOURCE_SCHEMA_ID,
      id,
      name: id,
      agent_id: 'support',
      cases: [],
      datasets: [],
      metrics: [],
    },
  });

const addEmptyDataset = (root: string, testId: string, datasetId: string) =>
  mutate(root, {
    schema,
    command: 'test.dataset.add',
    test_id: testId,
    dataset: {
      schema: DATASET_SCHEMA_ID,
      case_schema: CASE_SCHEMA_ID,
      id: datasetId,
      name: datasetId,
      case_count: 0,
    },
  });

const importDataset = (
  root: string,
  options: { as: string; source: string; testId: string },
  extra: Partial<Extract<TestAuthoringCommand, { command: 'test.dataset.import' }>> = {},
) =>
  mutate(root, {
    schema,
    command: 'test.dataset.import',
    test_id: options.testId,
    source: options.source,
    as: options.as,
    import: {},
    ...extra,
  });

const addCase = (root: string, testId: string, id: string) =>
  mutate(root, { schema, command: 'test.case.add', test_id: testId, case: { id, input: id } });

describe('runTestMutationCommand', { timeout: 20_000 }, () => {
  it('rejects a test whose agent does not exist without writing', async () => {
    const root = await createProject();
    const before = await snapshotProject(root);
    await expect(
      mutate(root, {
        schema,
        command: 'test.add',
        test: {
          schema: TEST_RESOURCE_SCHEMA_ID,
          id: 'broken',
          name: 'broken',
          agent_id: 'missing',
          cases: [],
          datasets: [],
          metrics: [],
        },
      }),
    ).rejects.toMatchObject({ code: 'project_invalid' });
    expect(await snapshotProject(root)).toEqual(before);
  });

  it('generates the same case id for direct and dataset imports and keeps it across a dataset rename', async () => {
    const root = await createProject();
    const source = await writeSource(
      root,
      'native.json',
      JSON.stringify([{ input: { prompt: 'same' }, expected: 'ok' }]),
    );
    await addTest(root, 'direct');
    await addTest(root, 'dataset-owner');
    await mutate(root, {
      schema,
      command: 'test.case.import',
      test_id: 'direct',
      source,
      import: {},
    });
    await importDataset(root, { as: 'native', source, testId: 'dataset-owner' });
    await mutate(root, {
      schema,
      command: 'test.dataset.rename',
      dataset_id: 'native',
      new_id: 'native-renamed',
    });

    const loaded = await loadProject({ project: root });
    const directId = loaded.tests.find(({ id }) => id === 'direct')?.cases[0]?.id;
    expect(directId).toBeDefined();
    expect(
      loaded.datasets.find(({ metadata }) => metadata.id === 'native-renamed')?.cases[0]?.id,
    ).toBe(directId);
    expect(loaded.tests.find(({ id }) => id === 'dataset-owner')?.datasets).toEqual([
      { dataset_id: 'native-renamed' },
    ]);
  });

  it('reports every case collision when attaching a dataset', async () => {
    const root = await createProject();
    const source = await writeSource(
      root,
      'collisions.jsonl',
      '{"id":"collision-one","input":1}\n{"id":"collision-two","input":2}\n',
    );
    await addTest(root, 'holding');
    await importDataset(root, { as: 'collisions', source, testId: 'holding' });
    await addCase(root, 'refund', 'collision-one');
    await addCase(root, 'refund', 'collision-two');
    const before = await snapshotProject(root);

    await expect(
      mutate(root, {
        schema,
        command: 'test.dataset.attach',
        test_id: 'refund',
        dataset_id: 'collisions',
      }),
    ).rejects.toMatchObject({
      code: 'project_invalid',
      details: { diagnostics: [expect.any(Object), expect.any(Object)] },
    });
    expect(await snapshotProject(root)).toEqual(before);
  });

  it('detaches and reattaches a dataset with tags without copying its rows', async () => {
    const root = await createProject();
    await addEmptyDataset(root, 'refund', 'empty');
    await mutate(root, {
      schema,
      command: 'test.dataset.detach',
      test_id: 'refund',
      dataset_id: 'empty',
    });
    await mutate(root, {
      schema,
      command: 'test.dataset.attach',
      test_id: 'refund',
      dataset_id: 'empty',
      tags: ['smoke'],
    });

    const loaded = await loadProject({ project: root });
    expect(loaded.datasets.find(({ metadata }) => metadata.id === 'empty')?.cases).toEqual([]);
    expect(loaded.tests[0]?.cases).toEqual([]);
    expect(loaded.tests[0]?.datasets).toEqual([
      { dataset_id: 'refunds' },
      { dataset_id: 'empty', tags: ['smoke'] },
    ]);
  });

  it('diffs a direct-case removal by case id instead of array position', async () => {
    const root = await createProject();
    for (const id of ['case-one', 'case-two', 'case-three']) await addCase(root, 'refund', id);

    const preview = await mutate(root, {
      schema,
      command: 'test.case.remove',
      test_id: 'refund',
      case_id: 'case-one',
      dry_run: true,
    });

    const testUpdate = preview.result.operations.find(
      ({ resource }) => resource.type === 'test' && resource.id === 'refund',
    );
    expect(testUpdate?.changes).toContainEqual(
      expect.objectContaining({ change: 'remove', path: '/cases/case-one' }),
    );
    expect(testUpdate?.changes.some(({ path }) => /^\/cases\/\d/u.test(path))).toBe(false);
  });

  it('rejects a direct import that collides with an attached case before writing', async () => {
    const root = await createProject();
    await addTest(root, 'target');
    const datasetSource = await writeSource(
      root,
      'attached.jsonl',
      '{"id":"attached-id","input":"dataset"}\n',
    );
    await importDataset(root, { as: 'attached', source: datasetSource, testId: 'target' });
    const directSource = await writeSource(
      root,
      'direct.json',
      '[{"id":"attached-id","input":"direct"}]',
    );
    const before = await snapshotProject(root);

    await expect(
      mutate(root, {
        schema,
        command: 'test.case.import',
        test_id: 'target',
        source: directSource,
        import: {},
      }),
    ).rejects.toMatchObject({
      code: 'project_invalid',
      details: { diagnostics: [{ code: 'resolved_case_collision' }] },
    });
    expect(await snapshotProject(root)).toEqual(before);
  });

  it('checks dataset import collisions only against cases the target attachment tags select', async () => {
    const root = await createProject();
    await addTest(root, 'filtered-target');
    await addCase(root, 'filtered-target', 'collision-id');
    await addEmptyDataset(root, 'filtered-target', 'filtered');
    await mutate(root, {
      schema,
      command: 'test.dataset.detach',
      test_id: 'filtered-target',
      dataset_id: 'filtered',
    });
    await mutate(root, {
      schema,
      command: 'test.dataset.attach',
      test_id: 'filtered-target',
      dataset_id: 'filtered',
      tags: ['billing'],
    });
    const source = await writeSource(
      root,
      'filtered.json',
      '[{"id":"collision-id","input":"dataset","tags":["support"]}]',
    );

    const imported = await importDataset(
      root,
      { as: 'filtered', source, testId: 'filtered-target' },
      { import: { sync: 'upsert' } },
    );
    expect(imported.result.committed).toBe(true);
  });

  it('keeps dataset import results deterministic and binds the manifest to the real timestamp', async () => {
    const root = await createProject();
    const source = await writeSource(root, 'stable.jsonl', '{"input":{"prompt":"same bytes"}}\n');
    const target = { as: 'stable', source, testId: 'refund' };

    const first = await importDataset(root, target, { dry_run: true });
    const second = await importDataset(root, target, { dry_run: true });
    expect(second).toEqual(first);

    const beforeCommit = Date.now();
    const committed = await importDataset(root, target);
    const afterCommit = Date.now();
    expect(committed.projectHashAfter).toBe(first.projectHashAfter);
    expect(committed.result.operations).toEqual(first.result.operations);

    const metadata = datasetResourceSchema.parse(
      JSON.parse(await readFile(join(root, 'attest/datasets/stable.meta.json'), 'utf8')),
    );
    const importedAt = Date.parse(metadata.provenance?.imported_at ?? '');
    expect(importedAt).toBeGreaterThanOrEqual(beforeCommit);
    expect(importedAt).toBeLessThanOrEqual(afterCommit);
    const manifest = projectManifestSchema.parse(
      JSON.parse(await readFile(join(root, 'attest.project.json'), 'utf8')),
    );
    expect(
      manifest.resources.datasets.find(({ id }) => id === 'stable')?.metadata_content_hash,
    ).toBe(contentHash(metadata));
  });

  it('upserts keyed dataset rows in order, keeps absent rows, and records provenance', async () => {
    const root = await createProject();
    const source = join(root, 'incremental.csv');
    const target = { as: 'incremental', source, testId: 'refund' };
    const upsert = {
      import: {
        mapping: [{ destination: 'input', source: 'prompt' }],
        key: 'external_id',
        sync: 'upsert' as const,
      },
    };
    await writeFile(source, 'external_id,prompt\none,old\ntwo,preserved\n');
    await importDataset(root, target, upsert);
    const initial = (await loadProject({ project: root })).datasets.find(
      ({ metadata }) => metadata.id === 'incremental',
    )?.cases;

    await writeFile(source, 'external_id,prompt\none,new\nthree,added\n');
    const updated = await importDataset(root, target, upsert);
    const counts = { inserted: 1, read: 2, skipped: 0, updated: 1 };
    expect(updated.result).toMatchObject({ imported_case_count: 2, import: { counts } });

    const dataset = (await loadProject({ project: root })).datasets.find(
      ({ metadata }) => metadata.id === 'incremental',
    );
    expect(dataset?.cases).toEqual([
      { id: initial?.[0]?.id, input: 'new' },
      initial?.[1],
      expect.objectContaining({ input: 'added' }),
    ]);
    expect(dataset?.metadata.provenance).toMatchObject({
      source_type: 'csv',
      key_field: 'external_id',
      mapping: [{ destination: 'input', source: 'prompt' }],
      counts,
    });
    expect(JSON.stringify(updated)).not.toContain(source);
    expect(JSON.stringify(dataset)).not.toContain(source);
  });

  it('refuses shared dataset updates without upsert and confirmation', async () => {
    const root = await createProject();
    await addTest(root, 'shared-owner');
    await addTest(root, 'shared-reader');
    await addEmptyDataset(root, 'shared-owner', 'shared');
    await mutate(root, {
      schema,
      command: 'test.dataset.attach',
      test_id: 'shared-reader',
      dataset_id: 'shared',
    });
    const source = await writeSource(root, 'shared.jsonl', '{"id":"shared-case","input":"v"}\n');
    const target = { as: 'shared', source, testId: 'shared-owner' };
    const upsert = { import: { sync: 'upsert' as const } };
    const affected = ['shared-owner', 'shared-reader'];
    const before = await snapshotProject(root);

    await expect(importDataset(root, target)).rejects.toMatchObject({ code: 'project_invalid' });
    await expect(importDataset(root, target, upsert)).rejects.toMatchObject({
      code: 'cli_missing_input',
      details: { affected_tests: affected },
    });
    expect(await snapshotProject(root)).toEqual(before);

    const preview = await importDataset(root, target, { ...upsert, dry_run: true });
    expect(preview.result).toMatchObject({ affected_tests: affected, committed: false });
    const confirmed = await importDataset(root, target, { ...upsert, yes: true });
    expect(confirmed.result).toMatchObject({ affected_tests: affected, committed: true });

    await addTest(root, 'shared-new');
    const newConsumer = await importDataset(
      root,
      { ...target, testId: 'shared-new' },
      { ...upsert, yes: true },
    );
    expect(newConsumer.result.affected_tests).toEqual(['shared-new', ...affected]);
  });

  it('rejects a confirmed import whose preview hash went stale after a concurrent attachment', async () => {
    const root = await createProject();
    await addTest(root, 'race-owner');
    await addTest(root, 'race-reader');
    await addEmptyDataset(root, 'race-owner', 'race');
    const source = await writeSource(root, 'race.jsonl', '{"id":"race-case","input":"late"}\n');
    const target = { as: 'race', source, testId: 'race-owner' };
    const upsert = { import: { sync: 'upsert' as const } };

    const preview = await importDataset(root, target, { ...upsert, dry_run: true });
    await mutate(root, {
      schema,
      command: 'test.dataset.attach',
      test_id: 'race-reader',
      dataset_id: 'race',
    });
    const afterAttachment = await snapshotProject(root);

    await expect(
      importDataset(root, target, {
        ...upsert,
        if_project_hash: preview.projectHashBefore ?? undefined,
        yes: true,
      }),
    ).rejects.toMatchObject({ code: 'project_changed' });
    expect(await snapshotProject(root)).toEqual(afterAttachment);
  });

  it('keeps the request path and its contents out of a malformed request error', async () => {
    const root = await createProject();
    const secret = 'super-secret-auth-token';
    const requestPath = await writeSource(root, 'request.json', `{not-json:${secret}}`);

    const error: unknown = await readCommandRequest('test.add', requestPath, {
      readStdin: () => Promise.reject(new Error('stdin must not be read')),
      workingDirectory: root,
    }).catch((caught: unknown) => caught);

    if (!(error instanceof LocalError)) throw new Error('Expected a LocalError.');
    expect(error.code).toBe('cli_usage');
    const { details, hint, message, path } = error;
    const rendered = JSON.stringify({ details, hint, message, path });
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain(requestPath);
  });
});
