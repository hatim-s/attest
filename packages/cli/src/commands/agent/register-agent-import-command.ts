import { runAgentImportCommand } from '@attest/local/agent';
import { Option, type Command } from 'commander';

import { renderCommandResult } from '../shared/command-result.js';
import {
  addMutationOptions,
  collectOption as collect,
  isInteractive,
  mergeCommonOptions,
  outputFormat,
  type MutationCliOptions,
} from '../shared/cli-options.js';
import {
  markAgentMutationHelp,
  mutationArguments,
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
      const result = await runAgentImportCommand({
        ...mutationArguments(options, context),
        agentId: options.as,
        attemptTimeout: options.attemptTimeout,
        bodyTimeout: options.bodyTimeout,
        connectTimeout: options.connectTimeout,
        errorPointer: options.errorPointer,
        firstByteTimeout: options.firstByteTimeout,
        headerEnv: options.headerEnv,
        idempotencyHeader: options.idempotencyHeader,
        interactive: isInteractive(options, context.interaction, options.fromJson),
        mapBody: options.mapBody,
        name: options.name,
        pollFailure: options.pollFailure,
        pollJobIdPointer: options.pollJobIdPointer,
        pollMaximumInterval: options.pollMaximumInterval,
        pollMinimumInterval: options.pollMinimumInterval,
        pollStatusPointer: options.pollStatusPointer,
        pollStatusUrlPointer: options.pollStatusUrlPointer,
        pollStatusUrlTemplate: options.pollStatusUrlTemplate,
        pollSuccess: options.pollSuccess,
        prompt: context.interaction.prompt,
        queryEnv: options.queryEnv,
        requestCapBytes: options.requestCapBytes,
        responseCapBytes: options.responseCapBytes,
        responsePointer: options.responsePointer,
        retries: options.retries,
        retryDelay: options.retryDelay,
        remoteJobIdPointer: options.remoteJobIdPointer,
        source,
        sourceType: options.type,
        tracePointer: options.tracePointer,
      });
      context.io.output(renderCommandResult('agent.import', outputFormat(options), result));
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
