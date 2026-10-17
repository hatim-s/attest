import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeFixtureProject } from '../../../_tests_/support/project-transaction.js';
import {
  acquireProjectLock,
  releaseProjectLock,
} from '../../../project/transaction/project-lock.js';
import { loadCommandProject } from '../load-command-project.js';

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
    const lock = await acquireProjectLock(root);

    try {
      await expect(loadCommandProject({ workingDirectory: root })).rejects.toMatchObject({
        code: 'project_locked',
      });
    } finally {
      await releaseProjectLock(lock);
    }
  });
});
