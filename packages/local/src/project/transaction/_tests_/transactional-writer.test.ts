import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { errnoCode } from '../../../internal/errno-code.js';
import { loadProject } from '../../project-loader/index.js';
import { prepareProjectCandidate } from '../candidate-project.js';
import { acquireProjectLock, releaseProjectLock } from '../project-lock.js';
import { candidateFromLoadedProject } from '../../../commands/project/load-command-project.js';
import {
  interruptAfterFirstPublish,
  writeFixtureProject,
} from '../../../_tests_/support/project-transaction.js';
import {
  TRANSACTIONS_DIRECTORY,
  prepareTransaction,
  recoverProjectTransactions,
} from '../transaction-journal.js';
import {
  applyProjectMutation,
  createFileChanges,
  publishPreparedTransaction,
  runPreparedTransaction,
} from '../transactional-writer.js';

const temporaryDirectories: string[] = [];

/** Creates one isolated project for transactional mutation tests. */
const createProject = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'attest-transaction-writer-'));
  temporaryDirectories.push(root);
  await writeFixtureProject(root);

  return root;
};

/** Captures every regular project file byte-for-byte in stable path order. */
const snapshotProjectFiles = async (root: string): Promise<ReadonlyMap<string, Buffer>> => {
  const files = new Map<string, Buffer>();

  const visit = async (directory: string): Promise<void> => {
    let entries;

    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error: unknown) {
      if (errnoCode(error) === 'ENOENT') {
        return;
      }

      throw error;
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files.set(relative(root, path), await readFile(path));
      }
    }
  };

  await visit(root);

  return files;
};

const expectSnapshotsEqual = (
  actual: ReadonlyMap<string, Buffer>,
  expected: ReadonlyMap<string, Buffer>,
): void => {
  expect([...actual.keys()]).toEqual([...expected.keys()]);

  for (const [path, contents] of expected) {
    expect(actual.get(path)).toEqual(contents);
  }
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('transactional project writer', () => {
  it('returns the commit semantic model while a dry run performs zero writes or locks', async () => {
    const dryRoot = await createProject();
    const commitRoot = await createProject();
    const loadedDry = await loadProject({ project: dryRoot });
    const loadedCommit = await loadProject({ project: commitRoot });
    const dryCandidate = candidateFromLoadedProject(loadedDry);
    const commitCandidate = candidateFromLoadedProject(loadedCommit);
    dryCandidate.tests[0]!.name = 'Updated refund';
    commitCandidate.tests[0]!.name = 'Updated refund';
    const before = await snapshotProjectFiles(dryRoot);

    const preview = await applyProjectMutation({
      candidate: dryCandidate,
      dryRun: true,
      expectedProjectHash: loadedDry.projectHash,
      projectRoot: dryRoot,
    });

    const committed = await applyProjectMutation({
      candidate: commitCandidate,
      expectedProjectHash: loadedCommit.projectHash,
      projectRoot: commitRoot,
    });

    expectSnapshotsEqual(await snapshotProjectFiles(dryRoot), before);
    await expect(stat(join(dryRoot, '.attest'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(preview.committed).toBe(false);
    expect(committed.committed).toBe(true);
    expect(preview.diff).toEqual(committed.diff);
    expect(preview.projectHashAfter).toBe(committed.projectHashAfter);
  });

  it('fails an optimistic hash mismatch before any transaction artifact is created', async () => {
    const root = await createProject();
    const loaded = await loadProject({ project: root });
    const candidate = candidateFromLoadedProject(loaded);
    candidate.project.name = 'Changed';
    const before = await snapshotProjectFiles(root);
    let failure: unknown;

    try {
      await applyProjectMutation({
        candidate,
        expectedProjectHash: '0'.repeat(64),
        projectRoot: root,
      });
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: 'project_changed',
      details: { current_hash: loaded.projectHash, expected_hash: '0'.repeat(64) },
    });
    expectSnapshotsEqual(await snapshotProjectFiles(root), before);
  });

  it('publishes multiple resources with canonical bytes and a verified manifest commit point', async () => {
    const root = await createProject();
    const loaded = await loadProject({ project: root });
    const candidate = candidateFromLoadedProject(loaded);
    candidate.agents[0]!.name = 'Updated support';
    candidate.metrics[0]!.name = 'Updated correctness';

    const result = await applyProjectMutation({ candidate, projectRoot: root });
    const verified = await loadProject({ project: root });
    const agentBytes = await readFile(join(root, 'attest/agents/support.json'), 'utf8');
    const metricBytes = await readFile(join(root, 'attest/metrics/correct.json'), 'utf8');

    expect(verified.projectHash).toBe(result.projectHashAfter);
    expect(verified.agents[0]?.name).toBe('Updated support');
    expect(verified.metrics[0]?.name).toBe('Updated correctness');
    expect(agentBytes).toMatch(/^\{\n  "id": "support"/u);
    expect(metricBytes).toMatch(/^\{\n  "definition":/u);
    expect(agentBytes.endsWith('\n')).toBe(true);
    expect(metricBytes.endsWith('\n')).toBe(true);
  });

  it('rolls back every published path when a later publish step fails', async () => {
    const root = await createProject();
    const loaded = await loadProject({ project: root });
    const candidate = candidateFromLoadedProject(loaded);
    candidate.agents[0]!.name = 'Will roll back';
    candidate.metrics[0]!.name = 'Will also roll back';
    const changes = createFileChanges(loaded, prepareProjectCandidate(candidate));
    const lock = await acquireProjectLock(root);

    try {
      const prepared = await prepareTransaction(root, changes);
      const [first, second] = prepared.journal.entries;

      if (first?.type !== 'write' || second?.type !== 'write') {
        throw new Error('Expected two staged writes first.');
      }

      const firstPath = join(root, first.path);
      const firstBytes = await readFile(firstPath, 'utf8');
      // A missing staged file makes the second rename fail after the first entry is published.
      await rm(join(prepared.directory, second.staged_path));

      await expect(
        runPreparedTransaction({ root, prepared, verify: async () => {} }),
      ).rejects.toMatchObject({ code: 'project_transaction_failed' });
      expect(await readFile(firstPath, 'utf8')).toBe(firstBytes);
      expect((await loadProject({ project: root })).projectHash).toBe(loaded.projectHash);
    } finally {
      await releaseProjectLock(lock);
    }
  });

  it('rolls an interrupted pre-manifest publish back from its recovery journal', async () => {
    const root = await createProject();
    const loaded = await loadProject({ project: root });
    const candidate = candidateFromLoadedProject(loaded);
    candidate.agents[0]!.name = 'Interrupted';
    candidate.metrics[0]!.name = 'Interrupted';
    const preparedCandidate = prepareProjectCandidate(candidate);
    const changes = createFileChanges(loaded, preparedCandidate);
    const lock = await acquireProjectLock(root);

    const prepared = await prepareTransaction(root, changes);

    try {
      const firstPath = join(root, prepared.journal.entries[0]!.path);
      const beforeBytes = await readFile(firstPath, 'utf8');
      await interruptAfterFirstPublish(root, prepared);
      expect(await readFile(firstPath, 'utf8')).not.toBe(beforeBytes);

      expect(await recoverProjectTransactions(root, lock)).toEqual([
        { action: 'rolled_back', transactionId: prepared.journal.transaction_id },
      ]);
      expect((await loadProject({ project: root })).projectHash).toBe(loaded.projectHash);
    } finally {
      await releaseProjectLock(lock);
    }
  });

  it('completes cleanup when recovery finds the new manifest commit point', async () => {
    const root = await createProject();
    const loaded = await loadProject({ project: root });
    const candidate = candidateFromLoadedProject(loaded);
    candidate.agents[0]!.name = 'Committed before crash';
    const preparedCandidate = prepareProjectCandidate(candidate);
    const changes = createFileChanges(loaded, preparedCandidate);
    const lock = await acquireProjectLock(root);

    const prepared = await prepareTransaction(root, changes);

    try {
      await publishPreparedTransaction(root, prepared);

      expect(await recoverProjectTransactions(root, lock)).toEqual([
        { action: 'completed_commit', transactionId: prepared.journal.transaction_id },
      ]);
      expect((await loadProject({ project: root })).projectHash).toBe(
        preparedCandidate.projectHash,
      );
      expect(await readdir(join(root, TRANSACTIONS_DIRECTORY))).toEqual([]);
    } finally {
      await releaseProjectLock(lock);
    }
  });

  it('preserves an external edit and leaves the journal when recovery cannot prove ownership', async () => {
    const root = await createProject();
    const loaded = await loadProject({ project: root });
    const candidate = candidateFromLoadedProject(loaded);
    candidate.agents[0]!.name = 'Interrupted';
    candidate.metrics[0]!.name = 'Interrupted';
    const preparedCandidate = prepareProjectCandidate(candidate);
    const changes = createFileChanges(loaded, preparedCandidate);
    const lock = await acquireProjectLock(root);

    const prepared = await prepareTransaction(root, changes);

    const externalBytes = '{"authored":"outside-attest"}\n';

    try {
      await interruptAfterFirstPublish(root, prepared);
      await writeFile(join(root, changes[0]!.path), externalBytes);

      let failure: unknown;

      try {
        await recoverProjectTransactions(root, lock);
      } catch (error: unknown) {
        failure = error;
      }

      expect(failure).toMatchObject({ code: 'project_recovery_required' });
      expect(await readFile(join(root, changes[0]!.path), 'utf8')).toBe(externalBytes);
      expect(await readdir(join(root, TRANSACTIONS_DIRECTORY))).toContain(
        prepared.journal.transaction_id,
      );
    } finally {
      await releaseProjectLock(lock);
    }
  });
});
