import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface PackageMetadata {
  name: string;
  version: string;
}

/**
 * Runs the temporary CLI entry point until Commander wiring arrives in Phase 1.
 */
function runCli(argv: string[]): Promise<number> {
  void argv;

  const packageMetadata = require('../package.json') as PackageMetadata;
  console.log(`${packageMetadata.name} ${packageMetadata.version}`);

  return Promise.resolve(0);
}

export { runCli };
