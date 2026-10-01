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
  child.on('error', (error) => {
    process.stderr.write(`orphan child spawn failed: ${error.message}\n`);
    process.stdout.write(
      JSON.stringify({
        protocol: request.protocol,
        error: { message: 'orphan child spawn failed' },
      }),
      () => process.exit(1),
    );
  });
  child.unref();

  const deadline = Date.now() + 5_000;
  const publishAfterHeartbeat = () => {
    if (!existsSync(heartbeatFile)) {
      if (Date.now() > deadline) {
        process.stderr.write('orphan heartbeat file never appeared\n');
        process.stdout.write(
          JSON.stringify({
            protocol: request.protocol,
            error: { message: 'orphan heartbeat file never appeared' },
          }),
          () => process.exit(1),
        );
        return;
      }
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
