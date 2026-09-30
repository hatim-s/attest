import { COMMAND_REQUEST_SCHEMA_ID } from '@attest/contracts';
import {
  readAgentTestInput,
  readCommandRequest,
  runAgentTestCommand,
  validateCommandRequest,
} from '@attest/local/agent';
import type { Command } from 'commander';

import { AttestCliError } from '../../errors/index.js';
import { setCliCommandHelpMetadata } from '../../help/command-help.js';
import { renderCommandResult } from '../shared/command-result.js';
import {
  addCommonOptions,
  isInteractive,
  mergeCommonOptions,
  outputFormat,
  type CommonCliOptions,
} from '../shared/cli-options.js';
import { promptRequired } from './agent-prompts.js';
import {
  assertNoAgentRequestOverlap,
  type RegisterAgentCommandsOptions,
} from './registration-support.js';

type TestOptions = CommonCliOptions & {
  fromJson?: string;
  input?: string;
  inputFile?: string;
  record?: boolean;
  watch?: boolean;
};

/** Registers local agent probing with cancellation and optional progress output. */
const registerAgentTestCommand = (agent: Command, context: RegisterAgentCommandsOptions): void => {
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
    .action(async (agentId: string | undefined, raw: TestOptions, command: Command) => {
      const options = mergeCommonOptions(raw, command, context.program);
      if (options.watch === true && outputFormat(options) !== 'human') {
        throw new AttestCliError('cli_usage', '--watch requires human output.', {
          path: '--watch',
        });
      }
      if (
        options.watch === true &&
        !isInteractive(options, context.interaction, options.fromJson)
      ) {
        throw new AttestCliError('cli_usage', '--watch requires an interactive human terminal.', {
          path: '--watch',
        });
      }

      assertNoAgentRequestOverlap(
        { fromJson: options.fromJson },
        {
          'agent-id': agentId,
          input: options.input,
          'input-file': options.inputFile,
          record: options.record,
        },
      );
      if (options.fromJson === '-' && options.inputFile === '-') {
        throw new AttestCliError(
          'cli_usage',
          'Command request and test input cannot share stdin.',
          {
            path: '--input-file',
          },
        );
      }

      const controller = new AbortController();
      const cancel = (): void => controller.abort();
      process.once('SIGINT', cancel);
      process.once('SIGTERM', cancel);
      try {
        const readRequest = {
          readStdin: context.interaction.readStdin,
          workingDirectory: context.workingDirectory,
        };
        const request =
          options.fromJson === undefined
            ? validateCommandRequest('agent.test', {
                schema: COMMAND_REQUEST_SCHEMA_ID,
                command: 'agent.test',
                agent_id: await promptRequired(agentId, 'Agent id', '<agent-id>', {
                  interactive: isInteractive(options, context.interaction, options.fromJson),
                  prompt: context.interaction.prompt,
                  signal: controller.signal,
                }),
                input: await readAgentTestInput({
                  input: options.input,
                  inputFile: options.inputFile,
                  ...readRequest,
                }),
                ...(options.record === undefined ? {} : { record: options.record }),
              })
            : await readCommandRequest('agent.test', options.fromJson, readRequest);
        const result = await runAgentTestCommand({
          onProgress: (message) => context.io.error(message),
          project: options.project,
          request,
          signal: controller.signal,
          watch: options.watch,
          workingDirectory: context.workingDirectory,
        });
        context.io.output(renderCommandResult('agent.test', outputFormat(options), result));
      } finally {
        process.off('SIGINT', cancel);
        process.off('SIGTERM', cancel);
      }
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
