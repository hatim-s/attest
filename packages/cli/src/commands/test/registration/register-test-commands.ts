import { registerTestCaseCommands } from './register-case-commands.js';
import { registerTestDatasetCommands } from './register-dataset-commands.js';
import { registerTestResourceCommands } from './register-test-resource-commands.js';
import type { RegisterTestCommandsOptions } from './support.js';

/** Registers the exact test, direct-case, and attached-dataset command surface. */
const registerTestCommands = (context: RegisterTestCommandsOptions): void => {
  const test = context.program.command('test').description('Author tests, cases, and datasets.');
  registerTestResourceCommands(test, context);
  registerTestCaseCommands(test, context);
  registerTestDatasetCommands(test, context);
};

export { registerTestCommands };
