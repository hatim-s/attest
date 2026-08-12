#!/usr/bin/env node

'use strict';

const { appendFileSync } = process.getBuiltinModule('node:fs');
const { spawn } = process.getBuiltinModule('node:child_process');

const heartbeatFile = process.env.ORPHAN_HEARTBEAT_FILE;
if (!heartbeatFile) {
  throw new Error('ORPHAN_HEARTBEAT_FILE is required');
}

const detachedProgram = `const { appendFileSync } = require('node:fs'); const file = process.argv[1]; setInterval(() => appendFileSync(file, 'beat\\n'), 200);`;
let handled = false;
process.on('SIGTERM', () => {
  if (handled) {
    return;
  }

  handled = true;
  const grandchild = spawn(process.execPath, ['-e', detachedProgram, heartbeatFile], {
    detached: true,
    stdio: 'ignore',
  });
  appendFileSync(heartbeatFile, `PID ${String(grandchild.pid)}\n`);
  grandchild.unref();
  // Remain discoverable long enough for the post-SIGTERM best-effort snapshot sweep.
  setTimeout(() => process.exit(0), 600);
});
setInterval(() => undefined, 60_000);
