import type { AgentResource, CommandRequest, JsonValue } from '@attest/contracts';

import { AttestCliError } from '../../../errors/index.js';
import { discoverProject } from '../../../project/discover-project.js';
import { loadCommandProject } from '../../project/load-command-project.js';
import { redactAgentResource } from '../../show/redact-resource.js';
import type { CommandResult } from '../../shared/command-result.js';
import {
  createImportedCurlAgentResource,
  readAgentCommandRequest,
  readCurlDocument,
  readImportedAgentResource,
} from '../agent-request.js';
import { createCurlImportRequest, prepareGuidedCurlOptions } from './curl-import-request.js';
import {
  assertNoFromJsonFlags,
  candidateFromLoaded,
  commaSeparated,
  mutationResult,
  promptDefault,
  promptRequired,
} from './command-support.js';
import type { AgentImportCommandOptions } from './types.js';

/** Imports one canonical JSON resource or inert cURL mapping without retaining source contents. */
const runAgentImportCommand = async (
  options: AgentImportCommandOptions,
): Promise<CommandResult> => {
  assertNoFromJsonFlags(options.fromJson, {
    'agent-id': options.agentId,
    'attempt-timeout': options.attemptTimeout,
    'body-timeout': options.bodyTimeout,
    'connect-timeout': options.connectTimeout,
    'error-pointer': options.errorPointer,
    'first-byte-timeout': options.firstByteTimeout,
    'header-env': options.headerEnv,
    'idempotency-header': options.idempotencyHeader,
    'map-body': options.mapBody,
    name: options.name,
    'poll-failure': options.pollFailure,
    'poll-job-id-pointer': options.pollJobIdPointer,
    'poll-maximum-interval': options.pollMaximumInterval,
    'poll-minimum-interval': options.pollMinimumInterval,
    'poll-status-pointer': options.pollStatusPointer,
    'poll-status-url-pointer': options.pollStatusUrlPointer,
    'poll-status-url-template': options.pollStatusUrlTemplate,
    'poll-success': options.pollSuccess,
    'query-env': options.queryEnv,
    'request-cap-bytes': options.requestCapBytes,
    'response-cap-bytes': options.responseCapBytes,
    'response-pointer': options.responsePointer,
    retries: options.retries,
    'retry-delay': options.retryDelay,
    'remote-job-id-pointer': options.remoteJobIdPointer,
    source: options.source,
    'trace-pointer': options.tracePointer,
    type: options.sourceType,
    'dry-run': options.dryRun,
    'if-project-hash': options.expectedProjectHash,
    yes: options.yes,
  });
  let source = options.source;
  let agentId = options.agentId;
  let name = options.name;
  let request: Extract<CommandRequest, { command: 'agent.import' }> | undefined;
  if (options.fromJson !== undefined) {
    request = await readAgentCommandRequest(
      options.fromJson,
      'agent.import',
      options.workingDirectory,
      options.readStdin,
    );
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
    source = request.source;
    agentId = request.as;
    name = request.name;
  }
  source = await promptRequired(
    source,
    'Agent import source',
    '<path|url|->',
    options.interactive,
    options.prompt,
  );
  agentId = await promptRequired(
    agentId,
    'Imported agent id',
    '--as',
    options.interactive,
    options.prompt,
  );
  const sourceType =
    request?.source_type ?? options.sourceType ?? (/\.curl$/iu.test(source) ? 'curl' : 'json');
  let agent: AgentResource;
  let importPreview: JsonValue | undefined;
  if (sourceType === 'curl') {
    const curlSource = await readCurlDocument(source, options.workingDirectory, options.readStdin);
    options = await prepareGuidedCurlOptions(options, curlSource);
    const responsePointer =
      request?.source_type === 'curl'
        ? request.extraction.result_pointer
        : options.responsePointer !== undefined
          ? options.responsePointer
          : await promptDefault(
              undefined,
              'Response JSON Pointer',
              '/answer',
              options.interactive,
              options.prompt,
            );
    let curlRequest =
      request?.source_type === 'curl'
        ? request
        : createCurlImportRequest({ agentId, name, options, responsePointer, source });
    const projectRoot = (
      await discoverProject({
        project: options.project,
        workingDirectory: options.workingDirectory,
      })
    ).root;
    let imported: Awaited<ReturnType<typeof createImportedCurlAgentResource>> | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        imported = await createImportedCurlAgentResource(curlRequest, curlSource, projectRoot);
        break;
      } catch (error: unknown) {
        if (
          request !== undefined ||
          !options.interactive ||
          options.prompt === undefined ||
          !(error instanceof AttestCliError) ||
          !/mapping|target/iu.test(error.message) ||
          attempt === 2
        ) {
          throw error;
        }
        options.mapBody = commaSeparated(
          await options.prompt(
            'Body mapping was invalid. Re-enter TARGET_POINTER=INPUT_POINTER values [none]: ',
          ),
        );
        curlRequest = createCurlImportRequest({ agentId, name, options, responsePointer, source });
      }
    }
    if (imported === undefined) throw new Error('Guided cURL import did not settle.');
    agent = imported.agent;
    importPreview = {
      request: imported.preview,
      extraction: curlRequest.extraction,
      ...(curlRequest.polling === undefined ? {} : { polling: curlRequest.polling }),
    };
  } else if (sourceType === 'json') {
    agent = await readImportedAgentResource(
      source,
      agentId,
      name,
      options.workingDirectory,
      options.readStdin,
    );
    if (agent.transport.kind === 'websocket') importPreview = redactAgentResource(agent);
  } else {
    throw new AttestCliError('cli_usage', 'Agent import type must be json or curl.', {
      path: '--type',
    });
  }
  const loaded = await loadCommandProject({
    project: options.project,
    recover: (request?.dry_run ?? options.dryRun) !== true,
    workingDirectory: options.workingDirectory,
  });
  if (loaded.agents.some(({ id }) => id === agent.id)) {
    throw new AttestCliError('project_invalid', `Agent ${agent.id} already exists.`, {
      path: agent.id,
    });
  }
  const candidate = candidateFromLoaded(loaded);
  candidate.agents.push(agent);
  return mutationResult(
    'agent.import',
    loaded,
    candidate,
    {
      dry_run: request?.dry_run ?? options.dryRun,
      if_project_hash: request?.if_project_hash ?? options.expectedProjectHash,
    },
    options.publishObserver,
    undefined,
    undefined,
    {
      definitionPreview: importPreview,
      interactive: options.interactive,
      nextCommand: `attest agent test ${agent.id}`,
      prompt: options.prompt,
      requireExplicit: false,
      yes: request?.yes ?? options.yes,
    },
  );
};

export { runAgentImportCommand };
