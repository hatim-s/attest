#!/usr/bin/env node

'use strict';

const { existsSync, writeFileSync } = process.getBuiltinModule('node:fs');
const { join } = process.getBuiltinModule('node:path');

const markerPath = join(process.cwd(), 'attempt-marker');
const statePath = process.env.MARKER_PROBE_STATE_FILE;
if (!statePath) {
  throw new Error('MARKER_PROBE_STATE_FILE is required');
}
let requestDocument = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  requestDocument += chunk;
});
process.stdin.on('end', () => {
  const request = JSON.parse(requestDocument);
  if (!existsSync(statePath)) {
    writeFileSync(statePath, 'first attempt completed');
    writeFileSync(markerPath, 'first attempt');
    process.stdout.write(JSON.stringify({ protocol: request.protocol }));
    return;
  }

  process.stdout.write(
    JSON.stringify({
      protocol: request.protocol,
      output: existsSync(markerPath) ? 'marker leaked across attempts' : 'attempt isolated',
    }),
  );
});
