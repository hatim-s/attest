import { runAgentRemoveCommand, runAgentRenameCommand } from '@attest/local/agent';
import type { Command } from 'commander';

import { setMutationHelp } from '../../help/command-help.js';
import {
  addMutationOptions,
  isInteractive,
  mutationRequestFields,
  outputFormat,
  type MutationCliOptions,
} from '../shared/cli-options.js';
import type { CommandContext } from '../shared/command-context.js';
import { readOrBuildRequest } from '../shared/command-request.js';
import { renderCommandResult } from '../shared/command-result.js';
import { requiredInput } from '../shared/required-input.js';

type RemoveOptions = MutationCliOptions & { detach?: boolean };

/** Registers agent rename and removal commands that update project references atomically. */
const registerAgentLifecycleCommands = (agent: Command, context: CommandContext): void => {
  const rename = addMutationOptions(
    agent
      .command('rename')
      .description('Rename an agent and every test reference atomically.')
      .argument('[agent-id]', 'current agent id')
      .argument('[new-id]', 'new agent id'),
  ).action(
    async (
      agentId: string | undefined,
      newId: string | undefined,
      options: MutationCliOptions,
      leaf: Command,
    ) => {
      const interactive = isInteractive(options, context.interaction, options.fromJson);
      const prompt = { interactive, prompt: context.interaction.prompt };
      const request = await readOrBuildRequest({
        command: 'agent.rename',
        context,
        leaf,
        options,
        build: async () => ({
          ...mutationRequestFields('agent.rename', options),
          agent_id: await requiredInput(
            agentId,
            { path: '<agent-id>', question: 'Agent id: ' },
            prompt,
          ),
          new_id: await requiredInput(
            newId,
            { path: '<new-id>', question: 'New agent id: ' },
            prompt,
          ),
        }),
      });
      const result = await runAgentRenameCommand({
        interactive,
        project: options.project,
        prompt: context.interaction.prompt,
        request,
        workingDirectory: context.workingDirectory,
      });
      context.io.output(renderCommandResult('agent.rename', outputFormat(options), result));
    },
  );
  setMutationHelp(rename, { examples: ['attest agent rename support support-renamed'] });

  const remove = addMutationOptions(
    agent
      .command('remove')
      .description('Remove an agent resource.')
      .argument('[agent-id]', 'agent id'),
  )
    .option('--detach', 'also remove tests that require this agent')
    .action(async (agentId: string | undefined, options: RemoveOptions, leaf: Command) => {
      const interactive = isInteractive(options, context.interaction, options.fromJson);
      const request = await readOrBuildRequest({
        command: 'agent.remove',
        context,
        leaf,
        options,
        build: async () => ({
          ...mutationRequestFields('agent.remove', options),
          agent_id: await requiredInput(
            agentId,
            { path: '<agent-id>', question: 'Agent id: ' },
            { interactive, prompt: context.interaction.prompt },
          ),
          ...(options.detach === undefined ? {} : { detach: options.detach }),
        }),
      });
      const result = await runAgentRemoveCommand({
        interactive,
        project: options.project,
        prompt: context.interaction.prompt,
        request,
        workingDirectory: context.workingDirectory,
      });
      context.io.output(renderCommandResult('agent.remove', outputFormat(options), result));
    });
  setMutationHelp(remove, { examples: ['attest agent remove support --dry-run'] });
};

export { registerAgentLifecycleCommands };
