#!/usr/bin/env node

'use strict';

const { existsSync } = process.getBuiltinModule('node:fs');
const { spawn } = process.getBuiltinModule('node:child_process');

const heartbeatFile = process.env.ORPHAN_HEARTBEAT_FILE;
if (!heartbeatFile) {
  throw new Error('ORPHAN_HEARTBEAT_FILE is required');
}

let requestDocument = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  requestDocument += chunk;
});
process.stdin.on('end', () => {
  const request = JSON.parse(requestDocument);
  const childProgram = `const { appendFileSync } = require('node:fs'); const file = process.argv[1]; appendFileSync(file, 'PID ' + process.pid + '\\n'); setInterval(() => appendFileSync(file, 'beat\\n'), 200);`;
  const child = spawn(process.execPath, ['-e', childProgram, heartbeatFile], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const publishAfterHeartbeat = () => {
    if (!existsSync(heartbeatFile)) {
      setTimeout(publishAfterHeartbeat, 10);
      return;
    }

    process.stdout.write(
      JSON.stringify({ protocol: request.protocol, output: 'normal-exit-orphan-started' }),
    );
    // Keep the parent present briefly so the terminal-time best-effort snapshot can retain identity.
    setTimeout(() => process.exit(0), 250);
  };
  publishAfterHeartbeat();
});
