import {
  createCurlImportRequest,
  readCommandRequest,
  readCurlDocument,
  runAgentImportCommand,
  validateCommandRequest,
} from '@attest/local/agent';
import { Option, type Command } from 'commander';

import { AttestCliError } from '../../errors/index.js';
import { renderCommandResult } from '../shared/command-result.js';
import {
  addMutationOptions,
  collectOption as collect,
  isInteractive,
  mergeCommonOptions,
  outputFormat,
  type MutationCliOptions,
} from '../shared/cli-options.js';
import { promptRequired } from './agent-prompts.js';
import {
  isCurlMappingError,
  promptBodyMappings,
  promptCurlImportFields,
} from './guided-agent-import.js';
import {
  agentMutationFields,
  assertNoAgentRequestOverlap,
  markAgentMutationHelp,
  type RegisterAgentCommandsOptions,
} from './registration-support.js';

type ImportOptions = MutationCliOptions & {
  as?: string;
  attemptTimeout?: string;
  bodyTimeout?: string;
  connectTimeout?: string;
  errorPointer?: string;
  firstByteTimeout?: string;
  headerEnv?: string[];
  idempotencyHeader?: string;
  mapBody?: string[];
  name?: string;
  pollFailure?: string[];
  pollJobIdPointer?: string;
  pollMaximumInterval?: string;
  pollMinimumInterval?: string;
  pollStatusPointer?: string;
  pollStatusUrlPointer?: string;
  pollStatusUrlTemplate?: string;
  pollSuccess?: string[];
  queryEnv?: string[];
  requestCapBytes?: string;
  responseCapBytes?: string;
  responsePointer?: string;
  retries?: string;
  retryDelay?: string;
  remoteJobIdPointer?: string;
  tracePointer?: string;
  type?: string;
};

/** Registers canonical JSON and cURL agent imports. */
const registerAgentImportCommand = (
  agent: Command,
  context: RegisterAgentCommandsOptions,
): void => {
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
    .action(async (source: string | undefined, raw: ImportOptions, command: Command) => {
      const options = mergeCommonOptions(raw, command, context.program);
      const { as: agentId, type: sourceType, ...flags } = options;
      assertNoAgentRequestOverlap(options, {
        'agent-id': agentId,
        'attempt-timeout': flags.attemptTimeout,
        'body-timeout': flags.bodyTimeout,
        'connect-timeout': flags.connectTimeout,
        'error-pointer': flags.errorPointer,
        'first-byte-timeout': flags.firstByteTimeout,
        'header-env': flags.headerEnv,
        'idempotency-header': flags.idempotencyHeader,
        'map-body': flags.mapBody,
        name: flags.name,
        'poll-failure': flags.pollFailure,
        'poll-job-id-pointer': flags.pollJobIdPointer,
        'poll-maximum-interval': flags.pollMaximumInterval,
        'poll-minimum-interval': flags.pollMinimumInterval,
        'poll-status-pointer': flags.pollStatusPointer,
        'poll-status-url-pointer': flags.pollStatusUrlPointer,
        'poll-status-url-template': flags.pollStatusUrlTemplate,
        'poll-success': flags.pollSuccess,
        'query-env': flags.queryEnv,
        'request-cap-bytes': flags.requestCapBytes,
        'response-cap-bytes': flags.responseCapBytes,
        'response-pointer': flags.responsePointer,
        retries: flags.retries,
        'retry-delay': flags.retryDelay,
        'remote-job-id-pointer': flags.remoteJobIdPointer,
        source,
        'trace-pointer': flags.tracePointer,
        type: sourceType,
      });
      const interactive = isInteractive(options, context.interaction, options.fromJson);
      const promptContext = { interactive, prompt: context.interaction.prompt };
      const readRequest = {
        readStdin: context.interaction.readStdin,
        workingDirectory: context.workingDirectory,
      };
      const runImport = async (
        request: Parameters<typeof runAgentImportCommand>[0]['request'],
        sourceText?: string,
      ) =>
        runAgentImportCommand({
          interactive,
          project: options.project,
          prompt: context.interaction.prompt,
          readStdin: context.interaction.readStdin,
          request,
          sourceText,
          workingDirectory: context.workingDirectory,
        });
      const output = (result: Awaited<ReturnType<typeof runAgentImportCommand>>): void =>
        context.io.output(renderCommandResult('agent.import', outputFormat(options), result));

      if (options.fromJson !== undefined) {
        const request = await readCommandRequest('agent.import', options.fromJson, readRequest);
        if (options.fromJson === '-' && request.source === '-') {
          throw new AttestCliError(
            'cli_usage',
            'Command request and agent source cannot share stdin.',
            {
              path: '/source',
              hint: 'Put either the request document or imported resource in a file.',
            },
          );
        }
        output(await runImport(request));
        return;
      }

      const importSource = await promptRequired(
        source,
        'Agent import source',
        '<path|url|->',
        promptContext,
      );
      const importId = await promptRequired(agentId, 'Imported agent id', '--as', promptContext);
      if ((sourceType ?? (/\.curl$/iu.test(importSource) ? 'curl' : 'json')) === 'json') {
        const request = validateCommandRequest('agent.import', {
          ...agentMutationFields('agent.import', options),
          source: importSource,
          source_type: 'json',
          as: importId,
          ...(flags.name === undefined ? {} : { name: flags.name }),
        });
        output(await runImport(request));
        return;
      }

      const curlSource = await readCurlDocument(
        importSource,
        context.workingDirectory,
        context.interaction.readStdin,
      );
      let fields = await promptCurlImportFields(
        {
          ...flags,
          agentId: importId,
          expectedProjectHash: flags.ifProjectHash,
          source: importSource,
        },
        curlSource,
        promptContext,
      );
      const MAX_IMPORT_ATTEMPTS = 3;
      for (let attempt = 1; ; attempt += 1) {
        try {
          output(await runImport(createCurlImportRequest(fields), curlSource));
          return;
        } catch (error: unknown) {
          if (!interactive || attempt === MAX_IMPORT_ATTEMPTS || !isCurlMappingError(error)) {
            throw error;
          }
          fields = { ...fields, mapBody: await promptBodyMappings(promptContext) };
        }
      }
    });

  markAgentMutationHelp(
    importCommand,
    [
      'attest agent import ./agent.json --type json --as support',
      'attest agent import request.curl --type curl --as support --map-body /prompt=/question --response-pointer /answer',
      'attest agent import --from-json ./agent-import.json --output json',
    ],
    {
      as: [],
      'attempt-timeout': [],
      'body-timeout': [],
      'connect-timeout': [],
      'error-pointer': [],
      'first-byte-timeout': [],
      'header-env': [],
      'idempotency-header': [],
      'map-body': [],
      name: [],
      path: [],
      'poll-failure': [],
      'poll-job-id-pointer': [],
      'poll-maximum-interval': [],
      'poll-minimum-interval': [],
      'poll-status-pointer': [],
      'poll-status-url-pointer': ['poll-status-url-template'],
      'poll-status-url-template': ['poll-status-url-pointer'],
      'poll-success': [],
      'query-env': [],
      'request-cap-bytes': [],
      'response-cap-bytes': [],
      'response-pointer': [],
      retries: [],
      'retry-delay': [],
      'remote-job-id-pointer': [],
      'trace-pointer': [],
      type: [],
    },
  );
};

export { registerAgentImportCommand };
