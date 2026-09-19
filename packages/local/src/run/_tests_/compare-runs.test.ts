import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { compareLocalRuns } from '../compare-runs.js';

it('does not create a missing run store during comparison', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-diff-'));
  try {
    await expect(
      compareLocalRuns({
        baseRunId: 'missing-base',
        candidateRunId: 'missing-candidate',
        storePath: 'runs.db',
        workingDirectory: directory,
      }),
    ).rejects.toMatchObject({ code: 'resource_not_found' });
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
