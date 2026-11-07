import { open, type FileHandle } from 'node:fs/promises';
import { vi } from 'vitest';
import * as Exit from 'effect/Exit';
import * as Context from 'effect/Context';
import * as Cause from 'effect/Cause';
import { CancellationRegistry } from '../../commands/eval/eval-cancellation.js';
import { valueFromExit } from '../../internal/effect-exit.js';
import * as Effect from 'effect/Effect';
import { stripStruct } from '@attest/contracts';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  parseWithSchemaSync,
  parseWithSchema,
  CASE_SCHEMA_ID,
  COMMAND_REQUEST_SCHEMA_ID,
  DATASET_SCHEMA_ID,
  PROJECT_SCHEMA_ID,
  TEST_RESOURCE_SCHEMA_ID,
  evalRunRequestSchema,
  projectManifestSchema,
  type DatasetResource,
  type EvalRunRequest,
  type ProjectManifest,
  type TestCase,
} from '@attest/contracts';
import {
  contentHash,
  hashCanonicalJsonLines,
  StoreError,
  type ProjectCatalog,
  type ProjectRecord,
} from '@attest/core';
import type { RunStartRequest } from '@attest/core/records';
import { describe, expect, it, onTestFinished } from 'vitest';
import * as Schema from 'effect/Schema';

import { writeFixtureProject } from '../../_tests_/support/project-transaction.js';
import { runTestMutationCommand } from '../../commands/test/test-mutation-command.js';
import { openTestStore as openStore, run as executeB2 } from '../../store/_tests_/b1-fixture.js';
import { createRunLauncher } from '../create-run-launcher.js';
import { toEvalRunDocument } from '../eval-run-document.js';
import { spawnEvalRun } from '../spawn-eval-run.js';

const fakeCli = {
  command: process.execPath,
  args: [fileURLToPath(new URL('fixtures/fake-attest-cli.mjs', import.meta.url))],
};

const receivedSchema = stripStruct({ argv: Schema.Array(Schema.String), document: Schema.Unknown });

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'attest-run-launcher-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  return root;
};

const catalogOf = (projects: ProjectRecord[]): ProjectCatalog => ({
  listProjects: () => Effect.succeed(projects),
  openProject: () => Effect.die(new Error('The launcher must not open run sources.')),
});

const launcherIn = (root: string, command = fakeCli) =>
  Effect.runSync(
    createRunLauncher({ catalog: catalogOf([{ key: 'demo', name: 'Demo', root }]), command }).pipe(
      Effect.provideService(CancellationRegistry, new Map()),
    ),
  );

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/** Returns the store error an operation rejects with. */
const captureStoreError = async (operation: Promise<unknown>): Promise<StoreError> => {
  try {
    await operation;
  } catch (error: unknown) {
    if (error instanceof StoreError) return error;

    throw error;
  }

  throw new Error('Expected the operation to fail.');
};

/** Gives the fixture's `refunds` dataset two tagged rows in place of its one untagged row. */
const writeTaggedDatasetRows = async (root: string): Promise<void> => {
  const rows: TestCase[] = [
    { id: 'card', input: 'card', tags: ['billing'] },
    { id: 'late', input: 'late', tags: ['refunds', 'slow'] },
  ];

  const metadata: DatasetResource = {
    schema: DATASET_SCHEMA_ID,
    case_schema: CASE_SCHEMA_ID,
    id: 'refunds',
    name: 'Refunds',
    case_count: rows.length,
  };

  const manifestPath = join(root, 'attest.project.json');

  const manifest = parseWithSchemaSync(
    projectManifestSchema,
    JSON.parse(await readFile(manifestPath, 'utf8')),
  );

  const datasets = manifest.resources.datasets.map((entry) => ({
    ...entry,
    data_content_hash: hashCanonicalJsonLines(rows),
    metadata_content_hash: contentHash(metadata),
  }));

  await writeFile(
    join(root, 'attest/datasets/refunds.jsonl'),
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  );
  await writeFile(join(root, 'attest/datasets/refunds.meta.json'), JSON.stringify(metadata));
  await writeFile(
    manifestPath,
    JSON.stringify({ ...manifest, resources: { ...manifest.resources, datasets } }),
  );
};

const waitFor = async (path: string): Promise<boolean> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await exists(path)) return true;
    await delay(25);
  }

  return false;
};

describe('toEvalRunDocument', () => {
  const fields = {
    schema: COMMAND_REQUEST_SCHEMA_ID,
    command: 'eval.run',
    output: 'jsonl',
  } as const;

  it.each<[RunStartRequest, EvalRunRequest]>([
    [{ selection: { all: true } }, { ...fields, all: true }],
    [
      {
        selection: { testIds: ['smoke', 'refund'] },
        tags: ['fast'],
        concurrency: 2,
        timeoutMs: 5000,
      },
      {
        ...fields,
        test_ids: ['smoke', 'refund'],
        tags: ['fast'],
        concurrency: 2,
        timeout_ms: 5000,
      },
    ],
  ])('maps %j to an eval.run document the CLI accepts', (request, expected) => {
    const document = toEvalRunDocument(request);

    expect(JSON.parse(JSON.stringify(document))).toEqual(expected);
    expect(parseWithSchema(evalRunRequestSchema, document).ok).toBe(true);
  });
});

describe('createRunLauncher', { timeout: 20_000 }, () => {
  it('starts a detached CLI in the project and resolves on run_started while it keeps running', async () => {
    const root = await temporaryRoot();
    const request: RunStartRequest = { selection: { testIds: ['smoke'] }, tags: ['slow'] };

    expect(
      await Effect.runPromiseExit(launcherIn(root).startRun('demo', request)).then(valueFromExit),
    ).toEqual({
      runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    });
    // The fake CLI writes `finished` only after its output outlasts the launcher's reading.
    expect(await exists(join(root, 'finished'))).toBe(false);

    const received = parseWithSchemaSync(
      receivedSchema,
      JSON.parse(await readFile(join(root, 'received.json'), 'utf8')),
    );

    expect(received.argv).toEqual([
      'eval',
      'run',
      '--project',
      root,
      '--non-interactive',
      '--from-json',
      '-',
    ]);
    expect(received.document).toEqual(JSON.parse(JSON.stringify(toEvalRunDocument(request))));
    expect(await waitFor(join(root, 'finished'))).toBe(true);
  });

  it('fails with the CLI diagnostics when the run does not start', async () => {
    const root = await temporaryRoot();

    await expect(
      Effect.runPromiseExit(
        launcherIn(root).startRun('demo', { selection: { all: true }, tags: ['invalid'] }),
      ).then(valueFromExit),
    ).rejects.toMatchObject({
      code: 'RUN_START_FAILED',
      message: 'Test nope was not found.',
      details: {
        code: 'resource_not_found',
        message: 'Test nope was not found.',
        hint: 'Run attest test list.',
        retryable: false,
      },
    });
  });

  it('reports the output of a CLI that exits without a result document', async () => {
    const root = await temporaryRoot();

    const failure = Effect.runPromiseExit(
      launcherIn(root).startRun('demo', {
        selection: { all: true },
        tags: ['crash'],
      }),
    ).then(valueFromExit);

    const message = 'The attest CLI exited with code 3 before the run started.';

    // The raw output stays out of the message, which the API sends as display text.
    await expect(failure).rejects.toMatchObject({
      code: 'RUN_START_FAILED',
      message,
      details: {
        code: 'run_failed',
        message,
        details: { output: ['TypeError: the CLI fell over'] },
      },
    });
  });

  it.each([
    ['many-lines', 'line 199'],
    ['long-line', 'y end'],
  ])('keeps only a bounded tail of what a CLI printing %s wrote', async (mode, last) => {
    const root = await temporaryRoot();

    const failure = await captureStoreError(
      Effect.runPromiseExit(
        launcherIn(root).startRun('demo', { selection: { all: true }, tags: [mode] }),
      ).then(valueFromExit),
    );

    const { output } = parseWithSchemaSync(
      stripStruct({ output: Schema.Array(Schema.String) }),
      failure.details?.details,
    );

    expect(output.length).toBeLessThanOrEqual(32);
    expect(output.join('').length).toBeLessThanOrEqual(16 * 1024);
    expect(output.at(-1)?.endsWith(last)).toBe(true);
  });

  it('stops a CLI that does not report run_started in time and says what it printed', async () => {
    const root = await temporaryRoot();
    const request: RunStartRequest = { selection: { all: true }, tags: ['idle'] };

    const failure = await captureStoreError(
      Effect.runPromiseExit(
        spawnEvalRun({
          command: fakeCli,
          projectRoot: root,
          document: toEvalRunDocument(request),
          startTimeoutMs: 500,
        }),
      ).then(valueFromExit),
    );

    const message = 'The attest CLI did not report run_started within 0.5s.';

    expect(failure).toMatchObject({
      code: 'RUN_START_FAILED',
      message,
      details: { code: 'run_failed', message, details: { output: ['loading the project'] } },
    });

    const pid = Number(await readFile(join(root, 'pid'), 'utf8'));

    // Signal 0 only checks: the stopped CLI's process is gone.
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  });

  it('fails to start when the CLI cannot be executed', async () => {
    const root = await temporaryRoot();
    const launcher = launcherIn(root, { command: join(root, 'missing-attest'), args: [] });

    const failure = Effect.runPromiseExit(
      launcher.startRun('demo', { selection: { all: true } }),
    ).then(valueFromExit);

    await expect(failure).rejects.toMatchObject({ code: 'RUN_START_FAILED' });
    await expect(failure).rejects.toThrow(`Could not run ${join(root, 'missing-attest')}`);
  });

  it('refuses projects it cannot reach before spawning anything', async () => {
    const launcher = Effect.runSync(
      createRunLauncher({
        catalog: catalogOf([{ key: 'hosted', name: 'Hosted' }]),
        command: { command: '/bin/false', args: [] },
      }).pipe(Effect.provideService(CancellationRegistry, new Map())),
    );

    await expect(
      Effect.runPromiseExit(launcher.startRun('hosted', { selection: { all: true } })).then(
        valueFromExit,
      ),
    ).rejects.toMatchObject({
      code: 'CONTROL_UNAVAILABLE',
    });
    await expect(
      Effect.runPromiseExit(launcher.listTests('other')).then(valueFromExit),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  it('lists tests with dataset rows counted as cases and the tags of every case', async () => {
    const root = await temporaryRoot();
    await writeFixtureProject(root);
    await writeTaggedDatasetRows(root);
    await Effect.runPromiseExit(
      runTestMutationCommand({
        project: root,
        readImportStdin: () => {
          throw new Error('stdin must not be read');
        },
        readStdin: () => Promise.reject(new Error('stdin must not be read')),
        request: {
          schema: COMMAND_REQUEST_SCHEMA_ID,
          command: 'test.add',
          test: {
            schema: TEST_RESOURCE_SCHEMA_ID,
            id: 'smoke',
            name: 'Smoke',
            agent_id: 'support',
            cases: [
              { id: 'one', input: 'one', tags: ['fast', 'billing'] },
              { id: 'two', input: 'two', tags: ['fast'] },
            ],
            // Only the rows tagged `billing`, so `late` and its tags stay out of this test.
            datasets: [{ dataset_id: 'refunds', tags: ['billing'] }],
            metrics: [],
          },
        },
        workingDirectory: root,
      }),
    ).then((exit) => valueFromExit(exit));

    const tests = await Effect.runPromiseExit(launcherIn(root).listTests('demo')).then(
      valueFromExit,
    );

    expect(tests.sort((left, right) => left.id.localeCompare(right.id))).toEqual([
      { id: 'refund', name: 'Refund', tags: ['billing', 'refunds', 'slow'], caseCount: 2 },
      { id: 'smoke', name: 'Smoke', tags: ['billing', 'fast'], caseCount: 3 },
    ]);
  });

  it('lists no tests for a project that has none', async () => {
    const root = await temporaryRoot();

    const manifest: ProjectManifest = {
      schema: PROJECT_SCHEMA_ID,
      project_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      name: 'empty',
      resources: { agents: [], tests: [], datasets: [], metrics: [] },
    };

    await writeFile(join(root, 'attest.project.json'), JSON.stringify(manifest));

    expect(
      await Effect.runPromiseExit(launcherIn(root).listTests('demo')).then(valueFromExit),
    ).toEqual([]);
  });

  it('answers PROJECT_UNLOADABLE with the loader diagnostics for a project that does not load', async () => {
    const root = await temporaryRoot();
    const launcher = launcherIn(root);

    await expect(
      Effect.runPromiseExit(launcher.listTests('demo')).then(valueFromExit),
    ).rejects.toMatchObject({
      code: 'PROJECT_UNLOADABLE',
      details: { code: 'project_not_found' },
    });

    await writeFile(
      join(root, 'attest.project.json'),
      JSON.stringify({ schema: PROJECT_SCHEMA_ID }),
    );
    const invalid = { code: 'PROJECT_UNLOADABLE', details: { code: 'project_invalid' } };

    await expect(
      Effect.runPromiseExit(launcher.listTests('demo')).then(valueFromExit),
    ).rejects.toMatchObject(invalid);
    await expect(
      Effect.runPromiseExit(launcher.cancelRun('demo', '01ARZ3NDEKTSV4RRFFQ69G5FAV')).then(
        valueFromExit,
      ),
    ).rejects.toMatchObject(invalid);
  });

  it('asks the process running a run to cancel it, wherever that run was started', async () => {
    const root = await temporaryRoot();
    await writeFixtureProject(root);
    const runId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const registry = join(root, '.attest', 'eval-runs');
    await mkdir(registry, { recursive: true });
    // The parent process stands in for a terminal `attest eval run` that registered this run.
    await writeFile(
      join(registry, `${runId}.json`),
      JSON.stringify({ pid: process.ppid, run_id: runId, token: 'terminal-run' }),
    );

    expect(
      await Effect.runPromiseExit(launcherIn(root).cancelRun('demo', runId)).then(valueFromExit),
    ).toEqual({
      outcome: 'cancellation_requested',
    });
    expect(JSON.parse(await readFile(join(registry, `${runId}.cancel.json`), 'utf8'))).toEqual({
      run_id: runId,
      token: 'terminal-run',
    });
  });

  it('reports runs that already finished and refuses ids that name no run', async () => {
    const root = await temporaryRoot();
    await writeFixtureProject(root);
    await mkdir(join(root, '.attest'));
    const store = await openStore(join(root, '.attest', 'runs.db'));
    const metadata = { schemaId: 'attest.project', configHash: 'hash', configJson: '{}' };
    const completed = await executeB2(store.runs.createRun(metadata));
    const cancelled = await executeB2(store.runs.createRun(metadata));
    await executeB2(store.runs.finalizeRun(completed.id, 'completed'));
    await executeB2(store.runs.finalizeRun(cancelled.id, 'cancelled'));
    await store.close();
    const launcher = launcherIn(root);

    expect(
      await Effect.runPromiseExit(launcher.cancelRun('demo', completed.id)).then(valueFromExit),
    ).toEqual({
      outcome: 'already_terminal',
    });
    expect(
      await Effect.runPromiseExit(launcher.cancelRun('demo', cancelled.id)).then(valueFromExit),
    ).toEqual({
      outcome: 'already_cancelled',
    });

    for (const runId of ['01ARZ3NDEKTSV4RRFFQ69G5FAZ', '../../../escape']) {
      await expect(
        Effect.runPromiseExit(launcher.cancelRun('demo', runId)).then(valueFromExit),
      ).rejects.toMatchObject({
        code: 'RUN_NOT_FOUND',
      });
    }
  });
});

it('retains unconfirmed timeout cleanup with the owned child receipt and never relaunches', async () => {
  const { OperationReleases } = await import('../../internal/operation-cleanup.js');
  const { killProcessTree } = await import('@attest/executor');
  const root = await temporaryRoot();
  let stops = 0;

  const outcome = await Effect.runPromiseExit(
    spawnEvalRun({
      command: fakeCli,
      projectRoot: root,
      document: toEvalRunDocument({ selection: { all: true }, tags: ['idle'] }),
      startTimeoutMs: 100,
      stopChild: (child, options) =>
        killProcessTree(child, options).pipe(
          Effect.map((receipt) => {
            stops++;

            return { ...receipt, cleanupConfirmed: false };
          }),
        ),
    }),
  );

  expect(stops).toBe(1);
  expect(Exit.isFailure(outcome)).toBe(true);

  if (!Exit.isFailure(outcome)) throw new Error('Expected a failed start.');
  expect(() => valueFromExit(outcome)).toThrow('did not report run_started');
  const releases = Context.getOrUndefined(Cause.annotations(outcome.cause), OperationReleases);
  expect(releases).toHaveLength(3);
  const cleanup = releases?.[0];
  expect(cleanup !== undefined && Exit.isFailure(cleanup)).toBe(true);

  if (cleanup !== undefined && Exit.isFailure(cleanup)) {
    const reason = cleanup.cause.reasons[0];
    expect(reason !== undefined && Cause.isFailReason(reason)).toBe(true);

    if (reason !== undefined && Cause.isFailReason(reason)) {
      expect(reason.error.message).toContain('may still be running');
      expect(reason.error.cause).toMatchObject({ receipt: { cleanupConfirmed: false } });
    }
  }
});

it('returns the live run id when closing the startup log fails after admission', async () => {
  const root = await temporaryRoot();
  const probe = await open(root, 'r');
  // SAFETY: Node owns this descriptor; the shared prototype is used only to inject a real close failure.
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  let injected = false;

  const spy = vi.spyOn(prototype, 'read').mockImplementation(function (this: FileHandle, ...args) {
    spy.mockRestore();
    const close = this.close.bind(this);
    this.close = async () => {
      await close();
      injected = true;
      throw new Error('lost close acknowledgement');
    };

    return this.read(...args);
  });

  try {
    const result = await Effect.runPromiseExit(
      spawnEvalRun({
        command: fakeCli,
        projectRoot: root,
        document: toEvalRunDocument({ selection: { all: true } }),
        startTimeoutMs: 5000,
      }),
    ).then(valueFromExit);

    expect(result).toEqual({ runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' });
    expect(injected).toBe(true);
  } finally {
    spy.mockRestore();
  }
});
