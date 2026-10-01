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
    let descendants: Awaited<ReturnType<typeof listDescendantProcesses>> = [];
    await vi.waitFor(async () => {
      descendants = await listDescendantProcesses(child.pid ?? -1);
      expect(descendants).toHaveLength(1);
    });

    const survivors = await killProcessTree(child, {
      graceMs: 200,
      initialDescendants: descendants,
      signalProcessGroup: true,
    });
    await closed;

    expect(survivors).toEqual([]);
  });
});
