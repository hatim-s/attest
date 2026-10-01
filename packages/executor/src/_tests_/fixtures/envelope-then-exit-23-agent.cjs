#!/usr/bin/env node

'use strict';

process.stdout.write(
  JSON.stringify({ protocol: 'attest.agent-invocation', output: 'valid-before-nonzero-exit' }),
);
process.exitCode = 23;
