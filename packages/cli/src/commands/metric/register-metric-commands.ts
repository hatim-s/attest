import { setCliCommandHelpMetadata } from '../../help/command-help.js';
import { registerMetricAddCommand } from './register-metric-add-command.js';
import { registerMetricImportCommand } from './register-metric-import-command.js';
import { registerMetricLifecycleCommands } from './register-metric-lifecycle-commands.js';
import { registerMetricTestCommand } from './register-metric-test-command.js';
import type { RegisterMetricCommandsOptions } from './registration-support.js';

/** Registers metric CRUD, local fixture tests, and redacted inspection commands. */
const registerMetricCommands = (context: RegisterMetricCommandsOptions): void => {
  const metric = context.program.command('metric').description('Author and test metric resources.');
  registerMetricAddCommand(metric, context);
  registerMetricImportCommand(metric, context);
  registerMetricTestCommand(metric, context);
  registerMetricLifecycleCommands(metric, context);
  setCliCommandHelpMetadata(metric, {
    examples: [
      'attest metric add correct --preset output-equals --value \'"Paris"\'',
      'attest metric test correct --fixture ./fixtures/result.json',
      'attest list metrics --output json',
      'attest show metric correct --output json',
    ],
  });
};

export { registerMetricCommands, type RegisterMetricCommandsOptions };
