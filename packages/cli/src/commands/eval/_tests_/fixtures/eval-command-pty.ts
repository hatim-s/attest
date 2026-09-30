import { runCli } from '../../../../run-cli.js';

// Runs the real CLI in the PTY the driver owns, against the project directory it was given.
const [projectRoot] = process.argv.slice(2);
process.exitCode = await runCli(['eval', 'run', '--watch'], { workingDirectory: projectRoot });
