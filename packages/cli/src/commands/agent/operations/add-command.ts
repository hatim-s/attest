import type { CommandRequest } from '@attest/contracts';

import { AttestCliError } from '../../../errors/index.js';
import { loadCommandProject } from '../../project/load-command-project.js';
import { redactAgentResource } from '../../show/redact-resource.js';
import {
  assertSafeNativeAgentResource,
  createAgentResource,
  readAgentCommandRequest,
} from '../agent-request.js';
import {
  assertNoFromJsonFlags,
  candidateFromLoaded,
  commaSeparated,
  mutationResult,
  promptDefault,
  promptOptional,
  promptRequired,
} from './command-support.js';
import type { AgentAddCommandOptions } from './types.js';
import type { CommandResult } from '../../shared/command-result.js';

/** Adds one native agent resource through the shared transactional project writer. */
const runAgentAddCommand = async (options: AgentAddCommandOptions): Promise<CommandResult> => {
  assertNoFromJsonFlags(options.fromJson, {
    'acknowledgement-pointer': options.acknowledgementPointer,
    'acknowledgement-value': options.acknowledgementValues,
    'agent-id': options.agentId,
    'argv-json': options.argvJson,
    'attempt-timeout': options.attemptTimeout,
    'background-command': options.backgroundCommand,
    'bridge-concurrency': options.bridgeConcurrency,
    'cancel-grace': options.cancellationGrace,
    'close-timeout': options.closeTimeout,
    'connection-mode': options.connectionMode,
    cwd: options.cwd,
    env: options.env,
    'error-pointer': options.errorPointer,
    'event-name': options.eventName,
    'header-env': options.headerEnv,
    'incremental-output-mode': options.incrementalOutputMode,
    'incremental-output-pointer': options.incrementalOutputPointer,
    'idle-timeout': options.idleTimeout,
    'invoke-url': options.invokeUrl,
    'jsonl-command': options.jsonlCommand,
    name: options.name,
    'native-command': options.nativeCommand,
    'native-http': options.nativeHttp,
    'open-timeout': options.openTimeout,
    'ping-interval': options.pingInterval,
    'readiness-http': options.readinessHttp,
    'readiness-stderr': options.readinessStderr,
    'readiness-tcp': options.readinessTcp,
    'request-id-pointer': options.requestIdPointer,
    'request-template': options.requestTemplate,
    'response-pointer': options.responsePointer,
    'shutdown-url': options.shutdownUrl,
    'stop-timeout': options.stopTimeout,
    'stream-framing': options.streamFraming,
    'stream-url': options.streamUrl,
    'terminal-pointer': options.terminalPointer,
    'terminal-value': options.terminalValues,
    timeout: options.timeout,
    trace: options.trace,
    'trace-pointer': options.tracePointer,
    subprotocol: options.webSocketSubprotocol,
    'websocket-lifecycle': options.webSocketLifecycle,
    'websocket-url': options.webSocketUrl,
    'dry-run': options.dryRun,
    'if-project-hash': options.expectedProjectHash,
    yes: options.yes,
  });
  let request: Extract<CommandRequest, { command: 'agent.add' }>;
  if (options.fromJson !== undefined) {
    request = await readAgentCommandRequest(
      options.fromJson,
      'agent.add',
      options.workingDirectory,
      options.readStdin,
    );
  } else {
    const agentId = await promptRequired(
      options.agentId,
      'Agent id',
      '<agent-id>',
      options.interactive,
      options.prompt,
    );
    let acknowledgementPointer = options.acknowledgementPointer;
    let acknowledgementValues = options.acknowledgementValues;
    let attemptTimeout = options.attemptTimeout;
    let backgroundCommand = options.backgroundCommand;
    let bridgeConcurrency = options.bridgeConcurrency;
    let cancellationGrace = options.cancellationGrace;
    let closeTimeout = options.closeTimeout;
    let connectionMode = options.connectionMode;
    let errorPointer = options.errorPointer;
    let headerEnv = options.headerEnv;
    let idleTimeout = options.idleTimeout;
    let invokeUrl = options.invokeUrl;
    let jsonlCommand = options.jsonlCommand;
    let nativeCommand = options.nativeCommand;
    let nativeHttp = options.nativeHttp;
    let openTimeout = options.openTimeout;
    let pingInterval = options.pingInterval;
    let readinessHttp = options.readinessHttp;
    let requestIdPointer = options.requestIdPointer;
    let requestTemplate = options.requestTemplate;
    let responsePointer = options.responsePointer;
    let stopTimeout = options.stopTimeout;
    let streamFraming = options.streamFraming;
    let streamUrl = options.streamUrl;
    let terminalPointer = options.terminalPointer;
    let terminalValues = options.terminalValues;
    let tracePointer = options.tracePointer;
    let webSocketLifecycle = options.webSocketLifecycle;
    let webSocketSubprotocol = options.webSocketSubprotocol;
    let webSocketUrl = options.webSocketUrl;
    if (
      options.argvJson === undefined &&
      nativeCommand === undefined &&
      nativeHttp === undefined &&
      options.backgroundCommand === undefined &&
      options.jsonlCommand === undefined &&
      options.streamUrl === undefined &&
      options.webSocketUrl === undefined &&
      options.interactive
    ) {
      const transport = (
        await options.prompt?.('Transport [cli/http/background/jsonl/stream/websocket]: ')
      )
        ?.trim()
        .toLowerCase();
      if (transport === 'http') {
        nativeHttp = await promptRequired(
          undefined,
          'Native HTTP URL',
          '--native-http',
          true,
          options.prompt,
        );
      } else if (transport === '' || transport === 'cli' || transport === undefined) {
        nativeCommand = await promptRequired(
          undefined,
          'Native command',
          '--native-command',
          true,
          options.prompt,
        );
      } else if (transport === 'background') {
        backgroundCommand = await promptRequired(
          undefined,
          'Background start command',
          '--background-command',
          true,
          options.prompt,
        );
        readinessHttp = await promptRequired(
          undefined,
          'Readiness HTTP URL',
          '--readiness-http',
          true,
          options.prompt,
        );
        invokeUrl = await promptRequired(
          undefined,
          'Invoke HTTP URL',
          '--invoke-url',
          true,
          options.prompt,
        );
        responsePointer = await promptDefault(
          undefined,
          'Result JSON Pointer',
          '/output',
          true,
          options.prompt,
        );
        stopTimeout = await promptDefault(undefined, 'Stop timeout', '5s', true, options.prompt);
      } else if (transport === 'jsonl') {
        jsonlCommand = await promptRequired(
          undefined,
          'JSONL bridge command',
          '--jsonl-command',
          true,
          options.prompt,
        );
        bridgeConcurrency = (await promptDefault(
          undefined,
          'Bridge concurrency',
          'serial',
          true,
          options.prompt,
        )) as 'serial' | 'multiplexed';
        cancellationGrace = await promptDefault(
          undefined,
          'Cancellation grace',
          '1s',
          true,
          options.prompt,
        );
      } else if (transport === 'stream') {
        streamUrl = await promptRequired(
          undefined,
          'Stream HTTP URL',
          '--stream-url',
          true,
          options.prompt,
        );
        streamFraming = (await promptDefault(
          undefined,
          'Stream framing',
          'sse',
          true,
          options.prompt,
        )) as 'sse' | 'jsonl';
        terminalPointer = await promptDefault(
          undefined,
          'Terminal JSON Pointer',
          '/type',
          true,
          options.prompt,
        );
        terminalValues = [
          await promptDefault(undefined, 'Terminal JSON value', '"result"', true, options.prompt),
        ];
        responsePointer = await promptDefault(
          undefined,
          'Result JSON Pointer',
          '/output',
          true,
          options.prompt,
        );
      } else if (transport === 'websocket') {
        webSocketUrl = await promptRequired(
          undefined,
          'WebSocket URL',
          '--websocket-url',
          true,
          options.prompt,
        );
        webSocketLifecycle = (await promptDefault(
          undefined,
          'WebSocket lifecycle',
          'per_run',
          true,
          options.prompt,
        )) as 'per_case' | 'per_run';
        connectionMode = (await promptDefault(
          undefined,
          'Connection mode',
          webSocketLifecycle === 'per_case' ? 'serial' : 'multiplexed',
          true,
          options.prompt,
        )) as 'serial' | 'multiplexed';
        headerEnv = commaSeparated(
          (await options.prompt?.(
            'Header environment references HEADER=ENV, comma-separated [none]: ',
          )) ?? '',
        );
        webSocketSubprotocol = await promptOptional(
          undefined,
          'WebSocket subprotocol',
          true,
          options.prompt,
        );
        requestTemplate = await promptDefault(
          undefined,
          'Request template JSON',
          '{"request_id":"{{request_id}}","request":"{{request}}"}',
          true,
          options.prompt,
        );
        requestIdPointer = await promptDefault(
          undefined,
          'Request id JSON Pointer',
          '/request_id',
          true,
          options.prompt,
        );
        acknowledgementPointer = await promptDefault(
          undefined,
          'Acknowledgement JSON Pointer',
          '/type',
          true,
          options.prompt,
        );
        acknowledgementValues = [
          await promptDefault(
            undefined,
            'Acknowledgement JSON value',
            '"acknowledgement"',
            true,
            options.prompt,
          ),
        ];
        responsePointer = await promptDefault(
          undefined,
          'Result JSON Pointer',
          '/output',
          true,
          options.prompt,
        );
        errorPointer = await promptDefault(
          undefined,
          'Error JSON Pointer',
          '/error',
          true,
          options.prompt,
        );
        tracePointer = await promptOptional(undefined, 'Trace JSON Pointer', true, options.prompt);
        openTimeout = await promptDefault(undefined, 'Open timeout', '10s', true, options.prompt);
        idleTimeout = await promptDefault(
          undefined,
          'Message idle timeout',
          '30s',
          true,
          options.prompt,
        );
        attemptTimeout = await promptDefault(
          undefined,
          'Attempt timeout',
          '60s',
          true,
          options.prompt,
        );
        pingInterval = await promptDefault(undefined, 'Ping interval', '15s', true, options.prompt);
        closeTimeout = await promptDefault(undefined, 'Close timeout', '5s', true, options.prompt);
      } else {
        throw new AttestCliError(
          'cli_usage',
          'Transport must be cli, http, background, jsonl, stream, or websocket.',
          {
            path: 'transport',
          },
        );
      }
    }
    request = {
      schema: 'attest.command-request',
      command: 'agent.add',
      agent: createAgentResource({
        acknowledgementPointer,
        acknowledgementValues,
        agentId,
        argvJson: options.argvJson,
        attemptTimeout,
        backgroundCommand,
        bridgeConcurrency,
        cancellationGrace,
        closeTimeout,
        connectionMode,
        cwd: options.cwd,
        env: options.env,
        errorPointer,
        eventName: options.eventName,
        headerEnv,
        incrementalOutputMode: options.incrementalOutputMode,
        incrementalOutputPointer: options.incrementalOutputPointer,
        idleTimeout,
        invokeUrl,
        jsonlCommand,
        name: options.name,
        nativeCommand,
        nativeHttp,
        openTimeout,
        pingInterval,
        readinessHttp,
        readinessStderr: options.readinessStderr,
        readinessTcp: options.readinessTcp,
        requestIdPointer,
        requestTemplate,
        responsePointer,
        shutdownUrl: options.shutdownUrl,
        stopTimeout,
        streamFraming,
        streamUrl,
        terminalPointer,
        terminalValues,
        timeout: options.timeout,
        trace: options.trace,
        tracePointer,
        webSocketLifecycle,
        webSocketSubprotocol,
        webSocketUrl,
      }),
      ...(options.dryRun === undefined ? {} : { dry_run: options.dryRun }),
      ...(options.expectedProjectHash === undefined
        ? {}
        : { if_project_hash: options.expectedProjectHash }),
      ...(options.yes === undefined ? {} : { yes: options.yes }),
    };
  }
  assertSafeNativeAgentResource(request.agent);
  const loaded = await loadCommandProject({
    project: options.project,
    recover: request.dry_run !== true,
    workingDirectory: options.workingDirectory,
  });
  if (loaded.agents.some(({ id }) => id === request.agent.id)) {
    throw new AttestCliError('project_invalid', `Agent ${request.agent.id} already exists.`, {
      path: request.agent.id,
      hint: 'Choose another id or remove the existing agent first.',
    });
  }
  const candidate = candidateFromLoaded(loaded);
  candidate.agents.push(request.agent);
  return mutationResult(
    'agent.add',
    loaded,
    candidate,
    request,
    options.publishObserver,
    undefined,
    undefined,
    {
      definitionPreview:
        request.agent.transport.kind === 'websocket'
          ? redactAgentResource(request.agent)
          : undefined,
      interactive: options.interactive,
      nextCommand: `attest agent test ${request.agent.id}`,
      prompt: options.prompt,
      requireExplicit: false,
      yes: request.yes,
    },
  );
};

export { runAgentAddCommand };
