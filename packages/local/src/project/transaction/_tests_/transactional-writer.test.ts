import { valueFromExit } from '../../../internal/effect-exit.js';
import * as Effect from 'effect/Effect';
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

    const loadedDry = await Effect.runPromiseExit(loadProject({ project: dryRoot })).then((exit) =>
      valueFromExit(exit),
    );

    const loadedCommit = await Effect.runPromiseExit(loadProject({ project: commitRoot })).then(
      (exit) => valueFromExit(exit),
    );

    let dryCandidate = candidateFromLoadedProject(loadedDry);
    let commitCandidate = candidateFromLoadedProject(loadedCommit);
    dryCandidate = {
      ...dryCandidate,
      tests: dryCandidate.tests.map((entry, index) =>
        index === 0 ? { ...dryCandidate.tests[0]!, name: 'Updated refund' } : entry,
      ),
    };
    commitCandidate = {
      ...commitCandidate,
      tests: commitCandidate.tests.map((entry, index) =>
        index === 0 ? { ...commitCandidate.tests[0]!, name: 'Updated refund' } : entry,
      ),
    };
    const before = await snapshotProjectFiles(dryRoot);

    const preview = await Effect.runPromiseExit(
      applyProjectMutation({
        candidate: dryCandidate,
        dryRun: true,
        expectedProjectHash: loadedDry.projectHash,
        projectRoot: dryRoot,
      }),
    ).then((exit) => valueFromExit(exit));

    const committed = await Effect.runPromiseExit(
      applyProjectMutation({
        candidate: commitCandidate,
        expectedProjectHash: loadedCommit.projectHash,
        projectRoot: commitRoot,
      }),
    ).then((exit) => valueFromExit(exit));

    expectSnapshotsEqual(await snapshotProjectFiles(dryRoot), before);
    await expect(stat(join(dryRoot, '.attest'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(preview.committed).toBe(false);
    expect(committed.committed).toBe(true);
    expect(preview.diff).toEqual(committed.diff);
    expect(preview.projectHashAfter).toBe(committed.projectHashAfter);
  });

  it('fails an optimistic hash mismatch before any transaction artifact is created', async () => {
    const root = await createProject();

    const loaded = await Effect.runPromiseExit(loadProject({ project: root })).then((exit) =>
      valueFromExit(exit),
    );

    let candidate = candidateFromLoadedProject(loaded);
    candidate = { ...candidate, project: { ...candidate.project, name: 'Changed' } };
    const before = await snapshotProjectFiles(root);
    let failure: unknown;

    try {
      await Effect.runPromiseExit(
        applyProjectMutation({
          candidate,
          expectedProjectHash: '0'.repeat(64),
          projectRoot: root,
        }),
      ).then((exit) => valueFromExit(exit));
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

    const loaded = await Effect.runPromiseExit(loadProject({ project: root })).then((exit) =>
      valueFromExit(exit),
    );

    let candidate = candidateFromLoadedProject(loaded);
    candidate = {
      ...candidate,
      agents: candidate.agents.map((entry, index) =>
        index === 0 ? { ...candidate.agents[0]!, name: 'Updated support' } : entry,
      ),
    };
    candidate = {
      ...candidate,
      metrics: candidate.metrics.map((entry, index) =>
        index === 0 ? { ...candidate.metrics[0]!, name: 'Updated correctness' } : entry,
      ),
    };

    const result = await Effect.runPromiseExit(
      applyProjectMutation({ candidate, projectRoot: root }),
    ).then((exit) => valueFromExit(exit));

    const verified = await Effect.runPromiseExit(loadProject({ project: root })).then((exit) =>
      valueFromExit(exit),
    );

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

    const loaded = await Effect.runPromiseExit(loadProject({ project: root })).then((exit) =>
      valueFromExit(exit),
    );

    let candidate = candidateFromLoadedProject(loaded);
    candidate = {
      ...candidate,
      agents: candidate.agents.map((entry, index) =>
        index === 0 ? { ...candidate.agents[0]!, name: 'Will roll back' } : entry,
      ),
    };
    candidate = {
      ...candidate,
      metrics: candidate.metrics.map((entry, index) =>
        index === 0 ? { ...candidate.metrics[0]!, name: 'Will also roll back' } : entry,
      ),
    };
    const changes = createFileChanges(loaded, prepareProjectCandidate(candidate));

    const lock = await Effect.runPromiseExit(acquireProjectLock(root)).then((exit) =>
      valueFromExit(exit),
    );

    try {
      const prepared = await Effect.runPromiseExit(prepareTransaction(root, changes)).then((exit) =>
        valueFromExit(exit),
      );

      const [first, second] = prepared.journal.entries;

      if (first?.type !== 'write' || second?.type !== 'write') {
        throw new Error('Expected two staged writes first.');
      }

      const firstPath = join(root, first.path);
      const firstBytes = await readFile(firstPath, 'utf8');
      // A missing staged file makes the second rename fail after the first entry is published.
      await rm(join(prepared.directory, second.staged_path));

      await expect(
        Effect.runPromiseExit(
          runPreparedTransaction({ root, prepared, verify: () => Effect.void }),
        ).then((exit) => valueFromExit(exit)),
      ).rejects.toMatchObject({ code: 'project_transaction_failed' });
      expect(await readFile(firstPath, 'utf8')).toBe(firstBytes);
      expect(
        (
          await Effect.runPromiseExit(loadProject({ project: root })).then((exit) =>
            valueFromExit(exit),
          )
        ).projectHash,
      ).toBe(loaded.projectHash);
    } finally {
      await Effect.runPromiseExit(releaseProjectLock(lock)).then((exit) => valueFromExit(exit));
    }
  });

  it('rolls an interrupted pre-manifest publish back from its recovery journal', async () => {
    const root = await createProject();

    const loaded = await Effect.runPromiseExit(loadProject({ project: root })).then((exit) =>
      valueFromExit(exit),
    );

    let candidate = candidateFromLoadedProject(loaded);
    candidate = {
      ...candidate,
      agents: candidate.agents.map((entry, index) =>
        index === 0 ? { ...candidate.agents[0]!, name: 'Interrupted' } : entry,
      ),
    };
    candidate = {
      ...candidate,
      metrics: candidate.metrics.map((entry, index) =>
        index === 0 ? { ...candidate.metrics[0]!, name: 'Interrupted' } : entry,
      ),
    };
    const preparedCandidate = prepareProjectCandidate(candidate);
    const changes = createFileChanges(loaded, preparedCandidate);

    const lock = await Effect.runPromiseExit(acquireProjectLock(root)).then((exit) =>
      valueFromExit(exit),
    );

    const prepared = await Effect.runPromiseExit(prepareTransaction(root, changes)).then((exit) =>
      valueFromExit(exit),
    );

    try {
      const firstPath = join(root, prepared.journal.entries[0]!.path);
      const beforeBytes = await readFile(firstPath, 'utf8');
      await interruptAfterFirstPublish(root, prepared);
      expect(await readFile(firstPath, 'utf8')).not.toBe(beforeBytes);

      expect(
        await Effect.runPromiseExit(recoverProjectTransactions(root, lock)).then((exit) =>
          valueFromExit(exit),
        ),
      ).toEqual([{ action: 'rolled_back', transactionId: prepared.journal.transaction_id }]);
      expect(
        (
          await Effect.runPromiseExit(loadProject({ project: root })).then((exit) =>
            valueFromExit(exit),
          )
        ).projectHash,
      ).toBe(loaded.projectHash);
    } finally {
      await Effect.runPromiseExit(releaseProjectLock(lock)).then((exit) => valueFromExit(exit));
    }
  });

  it('completes cleanup when recovery finds the new manifest commit point', async () => {
    const root = await createProject();

    const loaded = await Effect.runPromiseExit(loadProject({ project: root })).then((exit) =>
      valueFromExit(exit),
    );

    let candidate = candidateFromLoadedProject(loaded);
    candidate = {
      ...candidate,
      agents: candidate.agents.map((entry, index) =>
        index === 0 ? { ...candidate.agents[0]!, name: 'Committed before crash' } : entry,
      ),
    };
    const preparedCandidate = prepareProjectCandidate(candidate);
    const changes = createFileChanges(loaded, preparedCandidate);

    const lock = await Effect.runPromiseExit(acquireProjectLock(root)).then((exit) =>
      valueFromExit(exit),
    );

    const prepared = await Effect.runPromiseExit(prepareTransaction(root, changes)).then((exit) =>
      valueFromExit(exit),
    );

    try {
      await Effect.runPromiseExit(publishPreparedTransaction(root, prepared)).then((exit) =>
        valueFromExit(exit),
      );

      expect(
        await Effect.runPromiseExit(recoverProjectTransactions(root, lock)).then((exit) =>
          valueFromExit(exit),
        ),
      ).toEqual([{ action: 'completed_commit', transactionId: prepared.journal.transaction_id }]);
      expect(
        (
          await Effect.runPromiseExit(loadProject({ project: root })).then((exit) =>
            valueFromExit(exit),
          )
        ).projectHash,
      ).toBe(preparedCandidate.projectHash);
      expect(await readdir(join(root, TRANSACTIONS_DIRECTORY))).toEqual([]);
    } finally {
      await Effect.runPromiseExit(releaseProjectLock(lock)).then((exit) => valueFromExit(exit));
    }
  });

  it('preserves an external edit and leaves the journal when recovery cannot prove ownership', async () => {
    const root = await createProject();

    const loaded = await Effect.runPromiseExit(loadProject({ project: root })).then((exit) =>
      valueFromExit(exit),
    );

    let candidate = candidateFromLoadedProject(loaded);
    candidate = {
      ...candidate,
      agents: candidate.agents.map((entry, index) =>
        index === 0 ? { ...candidate.agents[0]!, name: 'Interrupted' } : entry,
      ),
    };
    candidate = {
      ...candidate,
      metrics: candidate.metrics.map((entry, index) =>
        index === 0 ? { ...candidate.metrics[0]!, name: 'Interrupted' } : entry,
      ),
    };
    const preparedCandidate = prepareProjectCandidate(candidate);
    const changes = createFileChanges(loaded, preparedCandidate);

    const lock = await Effect.runPromiseExit(acquireProjectLock(root)).then((exit) =>
      valueFromExit(exit),
    );

    const prepared = await Effect.runPromiseExit(prepareTransaction(root, changes)).then((exit) =>
      valueFromExit(exit),
    );

    const externalBytes = '{"authored":"outside-attest"}\n';

    try {
      await interruptAfterFirstPublish(root, prepared);
      await writeFile(join(root, changes[0]!.path), externalBytes);

      let failure: unknown;

      try {
        await Effect.runPromiseExit(recoverProjectTransactions(root, lock)).then((exit) =>
          valueFromExit(exit),
        );
      } catch (error: unknown) {
        failure = error;
      }

      expect(failure).toMatchObject({ code: 'project_recovery_required' });
      expect(await readFile(join(root, changes[0]!.path), 'utf8')).toBe(externalBytes);
      expect(await readdir(join(root, TRANSACTIONS_DIRECTORY))).toContain(
        prepared.journal.transaction_id,
      );
    } finally {
      await Effect.runPromiseExit(releaseProjectLock(lock)).then((exit) => valueFromExit(exit));
    }
  });
});
