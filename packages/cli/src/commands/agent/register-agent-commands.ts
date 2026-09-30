import { setCliCommandHelpMetadata } from '../../help/command-help.js';
import type { CommandContext } from '../shared/command-context.js';
import { registerAgentAddCommand } from './register-agent-add-command.js';
import { registerAgentImportCommand } from './register-agent-import-command.js';
import { registerAgentLifecycleCommands } from './register-agent-lifecycle-commands.js';
import { registerAgentTestCommand } from './register-agent-test-command.js';

/** Registers agent add, import, test, rename, and remove. */
const registerAgentCommands = (context: CommandContext): void => {
  const agent = context.program.command('agent').description('Author and test agent adapters.');
  registerAgentAddCommand(agent, context);
  registerAgentImportCommand(agent, context);
  registerAgentTestCommand(agent, context);
  registerAgentLifecycleCommands(agent, context);
  setCliCommandHelpMetadata(agent, {
    examples: ['attest agent add', 'attest agent test support --output json'],
  });
};

export { registerAgentCommands };
