import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { runHookCommand } from '../hook-command.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

/** Treats a zombie as terminated while still detecting a running descendant. */
const isProcessRunning = (processId: number): boolean => {
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(processId)], {
      encoding: 'utf8',
    }).trim();
    return state.length > 0 && !state.startsWith('Z');
  } catch {
    return false;
  }
};

describe('eval hook commands', () => {
  test('kills a hook descendant when the deadline expires', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'attest-hook-'));
    temporaryDirectories.push(directory);
    const childProcessIdPath = join(directory, 'child.pid');

    await expect(
      runHookCommand({
        command: {
          argv: [
            '/bin/sh',
            '-c',
            'sleep 30 & echo $! > "$1"; wait',
            'attest-hook',
            childProcessIdPath,
          ],
          timeout_ms: 3_000,
        },
        cwd: directory,
        env: { PATH: process.env.PATH ?? '' },
        phase: 'before_run',
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow('Eval before_run hook timed out.');

    const childProcessId = Number(await readFile(childProcessIdPath, 'utf8'));
    expect(isProcessRunning(childProcessId)).toBe(false);
  });

  test('does not include argv or inherited output in a nonzero-exit error', async () => {
    await expect(
      runHookCommand({
        command: {
          argv: [
            process.execPath,
            '-e',
            "process.stderr.write('secret-output'); process.exit(7)",
            'secret-argv',
          ],
        },
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? '' },
        phase: 'after_case',
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow('Eval after_case hook exited with code 7.');
  });
});
