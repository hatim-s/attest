#!/usr/bin/env node

'use strict';

const { appendFileSync } = process.getBuiltinModule('node:fs');

const heartbeatFile = process.env.ORPHAN_HEARTBEAT_FILE;
if (!heartbeatFile) {
  throw new Error('ORPHAN_HEARTBEAT_FILE is required');
}

process.stderr.write(`PID ${process.pid}\n`);
process.on('SIGTERM', () => undefined);
appendFileSync(heartbeatFile, 'started\n');
setInterval(() => appendFileSync(heartbeatFile, `${new Date().toISOString()}\n`), 200);
