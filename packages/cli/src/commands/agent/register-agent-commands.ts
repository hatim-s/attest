import { setCliCommandHelpMetadata } from '../../help/command-help.js';
import { registerAgentAddCommand } from './register-agent-add-command.js';
import { registerAgentImportCommand } from './register-agent-import-command.js';
import { registerAgentLifecycleCommands } from './register-agent-lifecycle-commands.js';
import { registerAgentTestCommand } from './register-agent-test-command.js';
import type { RegisterAgentCommandsOptions } from './registration-support.js';

/** Registers agent authoring plus native, HTTP, streaming, and WebSocket UX commands. */
const registerAgentCommands = (context: RegisterAgentCommandsOptions): void => {
  const agent = context.program.command('agent').description('Author and test agent adapters.');
  registerAgentAddCommand(agent, context);
  registerAgentImportCommand(agent, context);
  registerAgentTestCommand(agent, context);
  registerAgentLifecycleCommands(agent, context);
  setCliCommandHelpMetadata(agent, {
    examples: ['attest agent add', 'attest agent test support --output json'],
  });
};

export { registerAgentCommands, type RegisterAgentCommandsOptions };
