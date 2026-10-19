import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll } from 'vitest';

// The registry rejects symlinked ancestors, and macOS `tmpdir()` sits behind the `/var` link.
const attestHome = await mkdtemp(join(await realpath(tmpdir()), 'attest-home-'));

process.env.ATTEST_HOME = attestHome;

afterAll(() => rm(attestHome, { force: true, recursive: true }));
