import {
  createCurlImportRequest,
  readCurlDocument,
  runAgentImportCommand,
  validateCommandRequest,
  type CurlImportFields,
} from '@attest/local/agent';
import { Option, type Command } from 'commander';

import { setMutationHelp } from '../../help/command-help.js';
import {
  addMutationOptions,
  collect,
  isInteractive,
  mutationRequestFields,
  outputFormat,
  type MutationCliOptions,
} from '../shared/cli-options.js';
import type { CommandContext } from '../shared/command-context.js';
import { readJsonRequest } from '../shared/command-request.js';
import { renderCommandResult } from '../shared/command-result.js';
import { requiredInput } from '../shared/required-input.js';
import {
  isCurlMappingError,
  promptBodyMappings,
  promptCurlImportFields,
  type CurlFlags,
} from './guided-agent-import.js';

type ImportOptions = MutationCliOptions &
  Omit<CurlFlags, 'agentId' | 'dryRun' | 'expectedProjectHash' | 'source' | 'yes'> & {
    as?: string;
    type?: 'curl' | 'json';
  };

/** Guided imports re-ask for body mappings this many times before failing. */
const MAX_IMPORT_ATTEMPTS = 3;

/** Registers `agent import` for a canonical JSON resource or a mapped cURL request. */
const registerAgentImportCommand = (agent: Command, context: CommandContext): void => {
  const importCommand = addMutationOptions(
    agent
      .command('import')
      .description('Import one canonical JSON resource or safely mapped cURL request.')
      .argument('[path|url|-]', 'JSON resource, local cURL file, URL, or stdin'),
  )
    .option('--as <agent-id>', 'imported agent id')
    .addOption(new Option('--type <type>', 'import type').choices(['json', 'curl']))
    .option('--name <name>', 'override the imported display name')
    .option(
      '--map-body <target=input>',
      'replace one JSON body pointer with an input pointer',
      collect,
    )
    .option(
      '--header-env <header=source>',
      'replace a captured header with an env reference',
      collect,
    )
    .option(
      '--query-env <query=source>',
      'replace a captured query value with an env reference',
      collect,
    )
    .option('--response-pointer <pointer>', 'foreign response result JSON Pointer')
    .option('--error-pointer <pointer>', 'foreign response error JSON Pointer')
    .option('--trace-pointer <pointer>', 'foreign response trace JSON Pointer')
    .option('--remote-job-id-pointer <pointer>', 'foreign response job-id evidence pointer')
    .option('--poll-job-id-pointer <pointer>', 'submission job-id JSON Pointer')
    .option('--poll-status-url-pointer <pointer>', 'submission status-URL JSON Pointer')
    .option('--poll-status-url-template <url>', 'same-origin status URL with {{job_id}}')
    .option('--poll-status-pointer <pointer>', 'polled status JSON Pointer')
    .option('--poll-success <json>', 'terminal success JSON value', collect)
    .option('--poll-failure <json>', 'terminal failure JSON value', collect)
    .option('--poll-minimum-interval <duration>', 'minimum polling interval')
    .option('--poll-maximum-interval <duration>', 'maximum polling interval')
    .option('--idempotency-header <name>', 'stable submission idempotency header')
    .option('--connect-timeout <duration>', 'DNS/connect timeout')
    .option('--first-byte-timeout <duration>', 'response-header timeout')
    .option('--body-timeout <duration>', 'response body idle timeout')
    .option('--attempt-timeout <duration>', 'whole direct or polling attempt timeout')
    .option('--request-cap-bytes <bytes>', 'maximum materialized request bytes')
    .option('--response-cap-bytes <bytes>', 'maximum response body bytes')
    .option('--retries <count>', 'safe transport retry count')
    .option('--retry-delay <duration>', 'fixed transport retry delay')
    .action(async (source: string | undefined, options: ImportOptions, command: Command) => {
      const interactive = isInteractive(options, context.interaction, options.fromJson);
      const prompt = { interactive, prompt: context.interaction.prompt };
      const runImport = async (
        request: Parameters<typeof runAgentImportCommand>[0]['request'],
        sourceText?: string,
      ): Promise<void> => {
        const result = await runAgentImportCommand({
          interactive,
          project: options.project,
          prompt: context.interaction.prompt,
          readStdin: context.interaction.readStdin,
          request,
          sourceText,
          workingDirectory: context.workingDirectory,
        });
        context.io.output(renderCommandResult('agent.import', outputFormat(options), result));
      };

      if (options.fromJson !== undefined) {
        await runImport(
          await readJsonRequest({
            command: 'agent.import',
            context,
            leaf: command,
            options: { ...options, fromJson: options.fromJson },
          }),
        );
        return;
      }

      const importSource = await requiredInput(
        source,
        { path: '<path|url|->', question: 'Agent import source: ' },
        prompt,
      );
      const importId = await requiredInput(
        options.as,
        { path: '--as', question: 'Imported agent id: ' },
        prompt,
      );
      if ((options.type ?? (/\.curl$/iu.test(importSource) ? 'curl' : 'json')) === 'json') {
        await runImport(
          validateCommandRequest('agent.import', {
            ...mutationRequestFields('agent.import', options),
            source: importSource,
            source_type: 'json',
            as: importId,
            ...(options.name === undefined ? {} : { name: options.name }),
          }),
        );
        return;
      }

      const curlSource = await readCurlDocument(
        importSource,
        context.workingDirectory,
        context.interaction.readStdin,
      );
      let fields: CurlImportFields = await promptCurlImportFields(
        {
          ...options,
          agentId: importId,
          expectedProjectHash: options.ifProjectHash,
          source: importSource,
        },
        curlSource,
        prompt,
      );
      for (let attempt = 1; ; attempt += 1) {
        try {
          await runImport(createCurlImportRequest(fields), curlSource);
          return;
        } catch (error: unknown) {
          if (!interactive || attempt === MAX_IMPORT_ATTEMPTS || !isCurlMappingError(error)) {
            throw error;
          }
          fields = { ...fields, mapBody: await promptBodyMappings(prompt) };
        }
      }
    });

  setMutationHelp(importCommand, {
    examples: [
      'attest agent import ./agent.json --type json --as support',
      'attest agent import request.curl --type curl --as support --map-body /prompt=/question --response-pointer /answer',
      'attest agent import --from-json ./agent-import.json --output json',
    ],
    options: {
      'poll-status-url-pointer': { conflicts: ['poll-status-url-template'] },
      'poll-status-url-template': { conflicts: ['poll-status-url-pointer'] },
    },
  });
};

export { registerAgentImportCommand };
