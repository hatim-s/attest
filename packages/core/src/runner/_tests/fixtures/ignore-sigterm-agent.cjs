#!/usr/bin/env node

'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- Node 22.0-compatible CommonJS fixture. */
const { appendFileSync } = require('node:fs');

const heartbeatFile = process.env.ORPHAN_HEARTBEAT_FILE;
if (!heartbeatFile) {
  throw new Error('ORPHAN_HEARTBEAT_FILE is required');
}

process.stderr.write(`PID ${process.pid}\n`);
process.on('SIGTERM', () => undefined);
appendFileSync(heartbeatFile, 'started\n');
setInterval(() => appendFileSync(heartbeatFile, `${new Date().toISOString()}\n`), 200);
