import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  COMMAND_REQUEST_SCHEMA_ID,
  TEST_RESOURCE_SCHEMA_ID,
  evalRunRequestSchema,
  type EvalRunRequest,
} from '@attest/contracts';
import type { ProjectCatalog, ProjectRecord } from '@attest/core';
import type { RunStartRequest } from '@attest/core/records';
import { describe, expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';

import { writeFixtureProject } from '../../_tests_/support/project-transaction.js';
import { runTestMutationCommand } from '../../commands/test/test-mutation-command.js';
import { openStore } from '../../store/index.js';
import { createRunLauncher } from '../create-run-launcher.js';
import { toEvalRunDocument } from '../eval-run-document.js';

const fakeCli = {
  command: process.execPath,
  args: [fileURLToPath(new URL('fixtures/fake-attest-cli.mjs', import.meta.url))],
};

const receivedSchema = z.object({ argv: z.array(z.string()), document: z.unknown() });

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'attest-run-launcher-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));

  return root;
};

const catalogOf = (projects: ProjectRecord[]): ProjectCatalog => ({
  listProjects: () => Promise.resolve(projects),
  openProject: () => Promise.reject(new Error('The launcher must not open run sources.')),
});

const launcherIn = (root: string, command = fakeCli) =>
  createRunLauncher({ catalog: catalogOf([{ key: 'demo', name: 'Demo', root }]), command });

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

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
    expect(evalRunRequestSchema.safeParse(document).success).toBe(true);
  });
});

describe('createRunLauncher', { timeout: 20_000 }, () => {
  it('starts a detached CLI in the project and resolves on run_started while it keeps running', async () => {
    const root = await temporaryRoot();
    const request: RunStartRequest = { selection: { testIds: ['smoke'] }, tags: ['slow'] };

    expect(await launcherIn(root).startRun('demo', request)).toEqual({
      runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    });
    // The fake CLI writes `finished` only after its output outlasts the launcher's reading.
    expect(await exists(join(root, 'finished'))).toBe(false);

    const received = receivedSchema.parse(
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
      launcherIn(root).startRun('demo', { selection: { all: true }, tags: ['invalid'] }),
    ).rejects.toMatchObject({
      code: 'RUN_START_FAILED',
      message: 'Test nope was not found.',
      details: {
        code: 'cli_usage',
        message: 'Test nope was not found.',
        hint: 'Run attest test list.',
      },
    });
  });

  it('reports the output of a CLI that exits without a result document', async () => {
    const root = await temporaryRoot();

    const failure = launcherIn(root).startRun('demo', {
      selection: { all: true },
      tags: ['crash'],
    });

    await expect(failure).rejects.toMatchObject({ code: 'RUN_START_FAILED', details: undefined });
    await expect(failure).rejects.toThrow(
      'The attest CLI exited with code 3 before the run started.\nTypeError: the CLI fell over',
    );
  });

  it('fails to start when the CLI cannot be executed', async () => {
    const root = await temporaryRoot();
    const launcher = launcherIn(root, { command: join(root, 'missing-attest'), args: [] });

    const failure = launcher.startRun('demo', { selection: { all: true } });

    await expect(failure).rejects.toMatchObject({ code: 'RUN_START_FAILED' });
    await expect(failure).rejects.toThrow(`Could not run ${join(root, 'missing-attest')}`);
  });

  it('refuses projects it cannot reach before spawning anything', async () => {
    const launcher = createRunLauncher({
      catalog: catalogOf([{ key: 'hosted', name: 'Hosted' }]),
      command: { command: '/bin/false', args: [] },
    });

    await expect(launcher.startRun('hosted', { selection: { all: true } })).rejects.toMatchObject({
      code: 'CONTROL_UNAVAILABLE',
    });
    await expect(launcher.listTests('other')).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  it('lists tests with dataset rows counted as cases and the tags of every case', async () => {
    const root = await temporaryRoot();
    await writeFixtureProject(root);
    await runTestMutationCommand({
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
          datasets: [],
          metrics: [],
        },
      },
      workingDirectory: root,
    });

    const tests = await launcherIn(root).listTests('demo');

    expect(tests.sort((left, right) => left.id.localeCompare(right.id))).toEqual([
      { id: 'refund', name: 'Refund', tags: [], caseCount: 1 },
      { id: 'smoke', name: 'Smoke', tags: ['billing', 'fast'], caseCount: 2 },
    ]);
  });

  it('answers RUN_START_FAILED with the loader diagnostics for a project that does not load', async () => {
    const root = await temporaryRoot();

    await expect(launcherIn(root).listTests('demo')).rejects.toMatchObject({
      code: 'RUN_START_FAILED',
      details: { code: 'project_not_found' },
    });
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

    expect(await launcherIn(root).cancelRun('demo', runId)).toEqual({
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
    const completed = await store.runs.createRun(metadata);
    const cancelled = await store.runs.createRun(metadata);
    await store.runs.finalizeRun(completed.id, 'completed');
    await store.runs.finalizeRun(cancelled.id, 'cancelled');
    await store.close();
    const launcher = launcherIn(root);

    expect(await launcher.cancelRun('demo', completed.id)).toEqual({
      outcome: 'already_terminal',
    });
    expect(await launcher.cancelRun('demo', cancelled.id)).toEqual({
      outcome: 'already_cancelled',
    });

    for (const runId of ['01ARZ3NDEKTSV4RRFFQ69G5FAZ', '../../../escape']) {
      await expect(launcher.cancelRun('demo', runId)).rejects.toMatchObject({
        code: 'RUN_NOT_FOUND',
      });
    }
  });
});
