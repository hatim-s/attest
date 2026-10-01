import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeFixtureProject } from '../../../_tests_/support/project-transaction.js';
import { loadProject } from '../../../project/project-loader/index.js';
import { applyProjectMutation } from '../../../project/transaction/transactional-writer.js';
import { candidateFromLoadedProject, loadCommandProject } from '../load-command-project.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('loadCommandProject', () => {
  it('returns a stable lock conflict instead of observing a paused publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attest-load-command-project-'));
    temporaryDirectories.push(root);
    await writeFixtureProject(root);
    const candidate = candidateFromLoadedProject(await loadProject({ project: root }));
    candidate.agents[0]!.name = 'New snapshot';
    let signalPublished!: () => void;
    let releasePublication!: () => void;
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
          if (index !== 0) return;
          signalPublished();
          await publicationGate;
        },
      },
    );
    await publicationPaused;

    await expect(loadCommandProject({ workingDirectory: root })).rejects.toMatchObject({
      code: 'project_locked',
    });
    releasePublication();
    await mutation;
  });
});
