import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll } from 'vitest';

const attestHome = await mkdtemp(join(tmpdir(), 'attest-home-'));

process.env.ATTEST_HOME = attestHome;

afterAll(() => rm(attestHome, { force: true, recursive: true }));
