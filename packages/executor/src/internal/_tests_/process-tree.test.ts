import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import { describe, expect, it, vi } from 'vitest';

import {
  killProcessTree,
  listDescendantProcesses,
  parseIdentitySnapshot,
  parseProcessSnapshot,
  spawnInProcessGroup,
} from '../process-tree.js';

const row = (processId: number, parentProcessId: number, command: string): string => {
  return `${String(processId).padStart(5)} ${String(parentProcessId).padStart(5)} Thu Aug  6 19:00:00 2026 ${command}`;
};

describe('parseProcessSnapshot', () => {
  it('finds deep descendant chains while excluding reparented rows', () => {
    const snapshot = [
      row(100, 1, '/usr/bin/root'),
      row(101, 100, '/usr/bin/child'),
      row(102, 101, '/usr/bin/grandchild'),
      row(103, 102, '/usr/bin/great-grandchild'),
      row(104, 1, '/usr/bin/reparented'),
    ].join('\n');

    expect(parseProcessSnapshot(snapshot, 100)).toEqual([
      { processId: 101, startedAt: 'Thu Aug  6 19:00:00 2026', command: '/usr/bin/child' },
      { processId: 102, startedAt: 'Thu Aug  6 19:00:00 2026', command: '/usr/bin/grandchild' },
      {
        processId: 103,
        startedAt: 'Thu Aug  6 19:00:00 2026',
        command: '/usr/bin/great-grandchild',
      },
    ]);
  });

  it('ignores malformed rows and terminates self-referencing parent loops', () => {
    const snapshot = [
      'not ps output',
      row(200, 200, '/usr/bin/self'),
      row(201, 200, '/usr/bin/child'),
      '202 nope Thu Aug 6 broken',
    ].join('\n');

    expect(parseProcessSnapshot(snapshot, 200)).toEqual([
      { processId: 201, startedAt: 'Thu Aug  6 19:00:00 2026', command: '/usr/bin/child' },
    ]);
  });
});

describe('parseIdentitySnapshot', () => {
  it('parses every row returned by one batched ps identity query', () => {
    const snapshot = [
      '101 Thu Aug  6 19:00:00 2026 /usr/bin/child',
      '102 Thu Aug  6 19:00:01 2026 /usr/bin/grandchild',
      'malformed',
    ].join('\n');

    expect(parseIdentitySnapshot(snapshot)).toEqual([
      { processId: 101, startedAt: 'Thu Aug  6 19:00:00 2026', command: '/usr/bin/child' },
      {
        processId: 102,
        startedAt: 'Thu Aug  6 19:00:01 2026',
        command: '/usr/bin/grandchild',
      },
    ]);
  });
});

describe('killProcessTree', () => {
  it('reports no survivors once every tracked descendant is gone', async () => {
    // The parent keeps one child; killing the group must leave nothing for ps -p to report.
    const program = `require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); setInterval(() => {}, 1000);`;

    const child = spawnInProcessGroup([process.execPath, '-e', program], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '' },
    });

    const closed = new Promise((resolve) => child.once('close', resolve));

    let descendants: Effect.Success<ReturnType<typeof listDescendantProcesses>> = {
      identities: [],
      available: false,
    };

    await vi.waitFor(async () => {
      descendants = await Effect.runPromise(listDescendantProcesses(child.pid ?? -1));
      expect(descendants.identities).toHaveLength(1);
      expect(descendants.available).toBe(true);
    });

    const survivors = await Effect.runPromise(
      killProcessTree(child, {
        graceMs: 200,
        initialDescendants: descendants.identities,
        initialObservationAvailable: descendants.available,
        signalProcessGroup: true,
      }),
    );

    await closed;

    expect(survivors).toEqual({ unreapedProcessIds: [], cleanupConfirmed: true });
  });
  it('escalates an owned child that ignores TERM and confirms close', async () => {
    const child = spawnInProcessGroup(
      [
        process.execPath,
        '-e',
        "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);",
      ],
      { cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' } },
    );

    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));

    try {
      await new Promise<void>((resolve) => child.stdout?.once('data', () => resolve()));

      const survivors = await Effect.runPromise(
        killProcessTree(child, {
          graceMs: 50,
          signalProcessGroup: true,
        }),
      );

      await closed;
      expect(survivors).toEqual({ unreapedProcessIds: [], cleanupConfirmed: true });
      expect(child.signalCode).toBe('SIGKILL');
    } finally {
      await Effect.runPromise(killProcessTree(child, { graceMs: 0, signalProcessGroup: true }));
      await closed;
    }
  });

  it('joins a cleanup sweep before honoring fiber interruption', async () => {
    const child = spawnInProcessGroup(
      [
        process.execPath,
        '-e',
        "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);",
      ],
      { cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' } },
    );

    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));

    try {
      await new Promise<void>((resolve) => child.stdout?.once('data', () => resolve()));
      await Effect.runPromise(
        Effect.gen(function* () {
          const sweep = yield* Effect.forkChild(
            killProcessTree(child, {
              graceMs: 75,
              signalProcessGroup: true,
            }),
          );

          yield* Effect.sleep(10);
          yield* Fiber.interrupt(sweep);
        }),
      );
      await closed;
      expect(child.signalCode).toBe('SIGKILL');
    } finally {
      await Effect.runPromise(killProcessTree(child, { graceMs: 0, signalProcessGroup: true }));
      await closed;
    }
  });

  it('does not signal an identity whose start time no longer matches', async () => {
    const child = spawnInProcessGroup(
      [process.execPath, '-e', "process.stdout.write('ready'); setInterval(() => {}, 1000);"],
      { cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' } },
    );

    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));

    try {
      await new Promise<void>((resolve) => child.stdout?.once('data', () => resolve()));
      expect(child.pid).toBeDefined();

      const survivors = await Effect.runPromise(
        killProcessTree(child, {
          graceMs: 0,
          signalProcessGroup: false,
          initialDescendants: [
            { processId: child.pid!, startedAt: 'stale identity', command: 'node' },
          ],
        }),
      );

      expect(survivors).toEqual({ unreapedProcessIds: [], cleanupConfirmed: true });
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
    } finally {
      await Effect.runPromise(killProcessTree(child, { graceMs: 0, signalProcessGroup: true }));
      await closed;
    }
  });
  it('bounds an unresponsive ps observation inside a masked cleanup sweep', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'attest-stalled-ps-'));
    const pidFile = join(directory, 'ps-pid');
    await writeFile(
      join(directory, 'ps'),
      `#!/bin/sh
 echo $$ > "${pidFile}"
 exec /bin/sleep 30
`,
      { mode: 0o755 },
    );

    const child = spawnInProcessGroup([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '' },
    });

    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));

    try {
      vi.stubEnv('PATH', directory);
      const started = Date.now();

      const survivors = await Effect.runPromise(
        killProcessTree(child, {
          graceMs: 0,
          signalProcessGroup: true,
        }),
      );

      const snapshotPid = Number((await readFile(pidFile, 'utf8')).trim());
      expect(Date.now() - started).toBeLessThan(4000);
      expect(survivors).toEqual({ unreapedProcessIds: [], cleanupConfirmed: false });
      expect(() => process.kill(snapshotPid, 0)).toThrow();
      await closed;
    } finally {
      vi.unstubAllEnvs();
      await Effect.runPromise(killProcessTree(child, { graceMs: 0, signalProcessGroup: true }));
      await closed;
      await rm(directory, { recursive: true, force: true });
    }
  }, 7000);
});

it('retains verified survivors without confirming cleanup', async () => {
  const child = spawnInProcessGroup(
    [process.execPath, '-e', "process.stdout.write('ready'); setInterval(() => {}, 1000);"],
    { cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' } },
  );

  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const send = process.kill.bind(process);
  let restoreSignals: (() => void) | undefined;

  try {
    await new Promise<void>((resolve) => child.stdout?.once('data', () => resolve()));
    const snapshot = await Effect.runPromise(listDescendantProcesses(process.pid));
    const identity = snapshot.identities.find((candidate) => candidate.processId === child.pid);
    expect(identity).toBeDefined();

    if (identity === undefined) throw new Error('Owned fixture identity was not observed');

    // Emulate denied termination only for this owned fixture; every observation still uses real ps.
    const signals = vi
      .spyOn(process, 'kill')
      .mockImplementation((pid, signal) =>
        pid === child.pid && (signal === 'SIGTERM' || signal === 'SIGKILL')
          ? true
          : send(pid, signal),
      );

    restoreSignals = () => {
      signals.mockRestore();
    };

    const cleanup = await Effect.runPromise(
      killProcessTree(child, {
        graceMs: 0,
        signalProcessGroup: false,
        initialDescendants: [identity],
        initialObservationAvailable: snapshot.available,
      }),
    );

    expect(cleanup).toEqual({ unreapedProcessIds: [child.pid], cleanupConfirmed: false });
    expect(() => send(child.pid!, 0)).not.toThrow();
  } finally {
    restoreSignals?.();
    child.kill('SIGKILL');
    await closed;
  }
}, 10_000);
