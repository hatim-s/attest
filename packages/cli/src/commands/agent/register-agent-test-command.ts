import { COMMAND_REQUEST_SCHEMA_ID } from '@attest/contracts';
import { readAgentTestInput, runAgentTestCommand } from '@attest/local/agent';
import type { Command } from 'commander';

import { AttestCliError } from '../../errors/cli-error.js';
import { setCliCommandHelpMetadata } from '../../help/command-help.js';
import {
  addCommonOptions,
  isInteractive,
  outputFormat,
  type CommonCliOptions,
} from '../shared/cli-options.js';
import type { CommandContext } from '../shared/command-context.js';
import { readOrBuildRequest } from '../shared/command-request.js';
import { renderCommandResult } from '../shared/command-result.js';
import { withProcessSignals } from '../shared/process-signals.js';
import { requiredInput } from '../shared/required-input.js';

type TestOptions = CommonCliOptions & {
  fromJson?: string;
  input?: string;
  inputFile?: string;
  record?: boolean;
  watch?: boolean;
};

/** Registers `agent test`, which probes one agent and can be cancelled by a signal. */
const registerAgentTestCommand = (agent: Command, context: CommandContext): void => {
  const test = addCommonOptions(
    agent
      .command('test')
      .description(
        'Probe one native, managed-process, HTTP, polling, streaming, or WebSocket agent contract.',
      )
      .argument('[agent-id]', 'agent id'),
  )
    .option('--input <json>', 'test input as any JSON value')
    .option('--input-file <path|->', 'read test input JSON from a file or stdin')
    .option('--from-json <path|->', 'read one agent.test request')
    .option('--record', 'persist this probe as an eval run')
    .option('--watch', 'show human transport progress')
    .action(async (agentId: string | undefined, options: TestOptions, leaf: Command) => {
      const interactive = isInteractive(options, context.interaction, options.fromJson);
      if (options.watch === true && !interactive) {
        throw new AttestCliError('cli_usage', '--watch requires an interactive human terminal.', {
          path: '--watch',
        });
      }
      await withProcessSignals(async (signal) => {
        const request = await readOrBuildRequest({
          command: 'agent.test',
          context,
          leaf,
          options,
          build: async () => ({
            schema: COMMAND_REQUEST_SCHEMA_ID,
            command: 'agent.test',
            agent_id: await requiredInput(
              agentId,
              { path: '<agent-id>', question: 'Agent id: ' },
              { interactive, prompt: context.interaction.prompt, signal },
            ),
            input: await readAgentTestInput({
              input: options.input,
              inputFile: options.inputFile,
              readStdin: context.interaction.readStdin,
              workingDirectory: context.workingDirectory,
            }),
            ...(options.record === undefined ? {} : { record: options.record }),
          }),
        });
        const result = await runAgentTestCommand({
          onProgress: (message) => context.io.error(message),
          project: options.project,
          request,
          signal,
          watch: options.watch,
          workingDirectory: context.workingDirectory,
        });
        context.io.output(renderCommandResult('agent.test', outputFormat(options), result));
      });
    });

  setCliCommandHelpMetadata(test, {
    examples: [
      'attest agent test support --input \'{"question":"ping"}\' --output json',
      'attest agent test support --watch',
      'attest agent test support --record --output json',
      'attest agent test --from-json ./agent-test.json --output json',
    ],
    requestSchema: COMMAND_REQUEST_SCHEMA_ID,
    options: {
      output: { implies: ['non-interactive'] },
      input: { conflicts: ['input-file', 'from-json'] },
      'input-file': { conflicts: ['input', 'from-json'] },
      'from-json': {
        conflicts: ['agent-id', 'input', 'input-file', 'record'],
        implies: ['non-interactive'],
      },
      record: { conflicts: ['from-json'] },
      watch: { conflicts: ['output', 'non-interactive'] },
    },
  });
};

export { registerAgentTestCommand };
