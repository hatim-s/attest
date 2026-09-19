import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { openStore } from '../../store/index.js';
import { compareLocalRuns } from '../compare-runs.js';

it('compares an external store by absolute and parent-relative paths without modifying it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-diff-'));
  try {
    const workingDirectory = join(directory, 'project');
    const storeDirectory = join(directory, 'external');
    const storePath = join(storeDirectory, 'runs.db');
    await Promise.all([mkdir(workingDirectory), mkdir(storeDirectory)]);

    const store = await openStore(storePath);
    const base = await store.runs.createRun({
      schemaId: 'attest.project',
      configHash: 'base-config',
      configJson: '{}',
    });
    await store.runs.finalizeRun(base.id, 'completed');
    const candidate = await store.runs.createRun({
      schemaId: 'attest.project',
      configHash: 'candidate-config',
      configJson: '{}',
    });
    await store.runs.finalizeRun(candidate.id, 'completed');
    await store.close();

    const bytesBefore = await readFile(storePath);
    const filesBefore = await readdir(storeDirectory);
    const absoluteDiff = await compareLocalRuns({
      baseRunId: base.id,
      candidateRunId: candidate.id,
      storePath,
      workingDirectory,
    });
    const relativeDiff = await compareLocalRuns({
      baseRunId: base.id,
      candidateRunId: candidate.id,
      storePath: '../external/runs.db',
      workingDirectory,
    });

    expect(absoluteDiff.summary).toMatchObject({
      baseRunId: base.id,
      candidateRunId: candidate.id,
      baseConfigHash: 'base-config',
      candidateConfigHash: 'candidate-config',
    });
    expect(absoluteDiff.transitions).toEqual([]);
    expect(relativeDiff).toEqual(absoluteDiff);
    expect(await readFile(storePath)).toEqual(bytesBefore);
    expect(await readdir(storeDirectory)).toEqual(filesBefore);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('does not create a missing absolute store outside the working directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-diff-'));
  try {
    const workingDirectory = join(directory, 'project');
    const storeDirectory = join(directory, 'external');
    const storePath = join(storeDirectory, 'runs.db');
    await Promise.all([mkdir(workingDirectory), mkdir(storeDirectory)]);

    await expect(
      compareLocalRuns({
        baseRunId: 'missing-base',
        candidateRunId: 'missing-candidate',
        storePath,
        workingDirectory,
      }),
    ).rejects.toMatchObject({ code: 'resource_not_found' });
    expect(await readdir(storeDirectory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
