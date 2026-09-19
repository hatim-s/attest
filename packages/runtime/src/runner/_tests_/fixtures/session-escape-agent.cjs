#!/usr/bin/env node

'use strict';

const { existsSync } = process.getBuiltinModule('node:fs');
const { spawn } = process.getBuiltinModule('node:child_process');

const heartbeatFile = process.env.ORPHAN_HEARTBEAT_FILE;
if (!heartbeatFile) {
  throw new Error('ORPHAN_HEARTBEAT_FILE is required');
}

const grandchildProgram = `const fs = require('node:fs'); const file = process.argv[1]; process.stderr.write('PID ' + process.pid + '\\n'); fs.appendFileSync(file, 'started\\n'); setInterval(() => fs.appendFileSync(file, new Date().toISOString() + '\\n'), 200);`;
const setsidPath = ['/usr/bin/setsid', '/bin/setsid'].find((candidate) => existsSync(candidate));
const command = setsidPath ?? process.execPath;
const argumentsList =
  setsidPath === undefined
    ? ['-e', grandchildProgram, heartbeatFile]
    : [process.execPath, '-e', grandchildProgram, heartbeatFile];

const grandchild = spawn(command, argumentsList, {
  // setsid is preferred; detached Node is the portable process-group escape simulation.
  detached: setsidPath === undefined,
  stdio: ['ignore', 'ignore', 'inherit'],
});
grandchild.unref();
setInterval(() => undefined, 60_000);
