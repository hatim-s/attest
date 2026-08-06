#!/usr/bin/env node

import { runCli } from './index.js';

process.exit(await runCli(process.argv.slice(2)));
