#!/usr/bin/env node

'use strict';

process.stdout.write(
  JSON.stringify({ protocol: 'attest.agent/v1alpha1', output: 'valid-before-nonzero-exit' }),
);
process.exitCode = 23;
