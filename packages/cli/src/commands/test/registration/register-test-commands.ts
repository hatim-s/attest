import type { CommandContext } from '../../shared/command-context.js';
import { registerTestCaseCommands } from './register-case-commands.js';
import { registerTestDatasetCommands } from './register-dataset-commands.js';
import { registerTestResourceCommands } from './register-test-resource-commands.js';

/** Registers `test` with its direct-case and attached-dataset subcommands. */
const registerTestCommands = (context: CommandContext): void => {
  const test = context.program.command('test').description('Author tests, cases, and datasets.');
  registerTestResourceCommands(test, context);
  registerTestCaseCommands(test, context);
  registerTestDatasetCommands(test, context);
};

export { registerTestCommands };
