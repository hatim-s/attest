import {
  AGENT_RESOURCE_SCHEMA_ID,
  agentResourceSchema,
  type AgentResource,
} from '@attest/contracts';

import { AttestCliError } from '../../../errors/index.js';
import {
  parseArgvJson,
  parseDuration,
  parseJsonValues,
  parseRequestTemplate,
  parseSecretBindings,
  parseTcpReadiness,
  tokenizeCommand,
} from './input-parsers.js';
import { requestDiagnostics } from './json-source.js';
import { assertSafeNativeAgentResource } from './resource-validation.js';
import type { AgentAddFields } from './types.js';

const AUTHORING_FLAG_BY_FIELD: Readonly<Record<keyof AgentAddFields, string>> = {
  acknowledgementPointer: 'acknowledgement-pointer',
  acknowledgementValues: 'acknowledgement-value',
  agentId: 'agent-id',
  argvJson: 'argv-json',
  attemptTimeout: 'attempt-timeout',
  backgroundCommand: 'background-command',
  bridgeConcurrency: 'bridge-concurrency',
  cancellationGrace: 'cancel-grace',
  closeTimeout: 'close-timeout',
  connectionMode: 'connection-mode',
  cwd: 'cwd',
  env: 'env',
  errorPointer: 'error-pointer',
  eventName: 'event-name',
  headerEnv: 'header-env',
  incrementalOutputMode: 'incremental-output-mode',
  incrementalOutputPointer: 'incremental-output-pointer',
  idleTimeout: 'idle-timeout',
  invokeUrl: 'invoke-url',
  jsonlCommand: 'jsonl-command',
  name: 'name',
  nativeCommand: 'native-command',
  nativeHttp: 'native-http',
  openTimeout: 'open-timeout',
  pingInterval: 'ping-interval',
  readinessHttp: 'readiness-http',
  readinessStderr: 'readiness-stderr',
  readinessTcp: 'readiness-tcp',
  requestIdPointer: 'request-id-pointer',
  requestTemplate: 'request-template',
  responsePointer: 'response-pointer',
  shutdownUrl: 'shutdown-url',
  stopTimeout: 'stop-timeout',
  streamFraming: 'stream-framing',
  streamUrl: 'stream-url',
  terminalPointer: 'terminal-pointer',
  terminalValues: 'terminal-value',
  timeout: 'timeout',
  trace: 'trace',
  tracePointer: 'trace-pointer',
  webSocketLifecycle: 'websocket-lifecycle',
  webSocketSubprotocol: 'subprotocol',
  webSocketUrl: 'websocket-url',
};

const COMMON_AUTHORING_FIELDS = new Set<keyof AgentAddFields>(['agentId', 'name', 'trace']);

const TRANSPORT_AUTHORING_FIELDS: Readonly<
  Record<
    'background' | 'jsonl' | 'native_cli' | 'native_http' | 'stream' | 'websocket',
    Set<keyof AgentAddFields>
  >
> = {
  native_cli: new Set(['argvJson', 'nativeCommand', 'cwd', 'env', 'timeout']),
  native_http: new Set(['nativeHttp', 'headerEnv', 'timeout']),
  background: new Set([
    'backgroundCommand',
    'cwd',
    'env',
    'errorPointer',
    'headerEnv',
    'invokeUrl',
    'readinessHttp',
    'readinessStderr',
    'readinessTcp',
    'responsePointer',
    'shutdownUrl',
    'stopTimeout',
    'tracePointer',
    'timeout',
  ]),
  jsonl: new Set([
    'jsonlCommand',
    'cwd',
    'env',
    'bridgeConcurrency',
    'cancellationGrace',
    'timeout',
  ]),
  stream: new Set([
    'streamUrl',
    'streamFraming',
    'headerEnv',
    'errorPointer',
    'eventName',
    'incrementalOutputMode',
    'incrementalOutputPointer',
    'responsePointer',
    'terminalPointer',
    'terminalValues',
    'tracePointer',
    'timeout',
  ]),
  websocket: new Set([
    'acknowledgementPointer',
    'acknowledgementValues',
    'attemptTimeout',
    'closeTimeout',
    'connectionMode',
    'errorPointer',
    'headerEnv',
    'idleTimeout',
    'openTimeout',
    'pingInterval',
    'requestIdPointer',
    'requestTemplate',
    'responsePointer',
    'tracePointer',
    'webSocketLifecycle',
    'webSocketSubprotocol',
    'webSocketUrl',
  ]),
};

const fieldIsProvided = (value: AgentAddFields[keyof AgentAddFields]): boolean =>
  value !== undefined && (!Array.isArray(value) || value.length > 0);

/** Rejects every flag that the selected transport would otherwise silently discard. */
const assertApplicableAuthoringFlags = (
  fields: AgentAddFields,
  selected: keyof typeof TRANSPORT_AUTHORING_FIELDS,
): void => {
  const allowed = TRANSPORT_AUTHORING_FIELDS[selected];
  const incompatibleOptions: string[] = [];
  for (const field of Object.keys(AUTHORING_FLAG_BY_FIELD) as (keyof AgentAddFields)[]) {
    if (
      fieldIsProvided(fields[field]) &&
      !COMMON_AUTHORING_FIELDS.has(field) &&
      !allowed.has(field)
    ) {
      incompatibleOptions.push(`--${AUTHORING_FLAG_BY_FIELD[field]}`);
    }
  }
  if (incompatibleOptions.length > 0) {
    incompatibleOptions.sort();
    throw new AttestCliError(
      'cli_usage',
      `Options ${incompatibleOptions.join(', ')} are not valid for this transport.`,
      {
        path: incompatibleOptions[0],
        hint: 'Remove the incompatible options or select the transport that owns them.',
        details: { incompatible_options: incompatibleOptions },
      },
    );
  }
  if (
    selected === 'stream' &&
    fields.incrementalOutputMode !== undefined &&
    fields.incrementalOutputPointer === undefined
  ) {
    throw new AttestCliError(
      'cli_usage',
      'Option --incremental-output-mode requires --incremental-output-pointer.',
      {
        path: '--incremental-output-mode',
        hint: 'Add the event JSON Pointer to accumulate or remove the mode option.',
      },
    );
  }
};

/** Normalizes non-interactive or wizard-populated add fields into one resource. */
const createAgentResource = (fields: AgentAddFields): AgentResource => {
  const selections = [
    fields.argvJson === undefined ? undefined : ('native_cli' as const),
    fields.nativeCommand === undefined ? undefined : ('native_cli' as const),
    fields.nativeHttp === undefined ? undefined : ('native_http' as const),
    fields.backgroundCommand === undefined ? undefined : ('background' as const),
    fields.jsonlCommand === undefined ? undefined : ('jsonl' as const),
    fields.streamUrl === undefined ? undefined : ('stream' as const),
    fields.webSocketUrl === undefined ? undefined : ('websocket' as const),
  ].filter((value) => value !== undefined);
  if (selections.length !== 1) {
    throw new AttestCliError(
      selections.length === 0 ? 'cli_missing_input' : 'cli_usage',
      'Select exactly one agent transport.',
      {
        path: '--argv-json',
        hint: 'Pass one of `--argv-json`, `--native-command`, `--native-http`, `--background-command`, `--jsonl-command`, `--stream-url`, or `--websocket-url`.',
        details: {
          selected_transports: selections,
        },
      },
    );
  }
  assertApplicableAuthoringFlags(fields, selections[0]!);
  const timeout = fields.timeout === undefined ? undefined : parseDuration(fields.timeout);
  const name = fields.name?.trim() || fields.agentId;
  const processEnvironment =
    fields.env === undefined || fields.env.length === 0
      ? {}
      : { env: parseSecretBindings(fields.env, '--env') };
  let transport: AgentResource['transport'];
  if (fields.nativeHttp !== undefined) {
    transport = {
      kind: 'http',
      lifecycle: 'external',
      response_mode: 'attest_envelope',
      request: {
        url: fields.nativeHttp,
        method: 'POST',
        ...(fields.headerEnv === undefined || fields.headerEnv.length === 0
          ? {}
          : { headers: parseSecretBindings(fields.headerEnv, '--header-env') }),
      },
      extraction: { result_pointer: '' },
    };
  } else if (fields.backgroundCommand !== undefined) {
    const readiness = [fields.readinessHttp, fields.readinessTcp, fields.readinessStderr].filter(
      (value) => value !== undefined,
    );
    if (readiness.length !== 1 || fields.invokeUrl === undefined) {
      throw new AttestCliError(
        'cli_missing_input',
        'Background agents require invoke URL and exactly one readiness probe.',
        {
          path: '--invoke-url',
          hint: 'Pass --invoke-url plus one of --readiness-http, --readiness-tcp, or --readiness-stderr.',
        },
      );
    }
    const readinessDefinition =
      fields.readinessHttp !== undefined
        ? { kind: 'http' as const, url: fields.readinessHttp }
        : fields.readinessTcp !== undefined
          ? { kind: 'tcp' as const, ...parseTcpReadiness(fields.readinessTcp) }
          : { kind: 'stderr' as const, pattern: fields.readinessStderr! };
    transport = {
      kind: 'background_cli',
      lifecycle: 'per_run',
      start_argv: tokenizeCommand(fields.backgroundCommand),
      ...(fields.cwd === undefined ? {} : { cwd: fields.cwd }),
      ...processEnvironment,
      readiness: readinessDefinition,
      invoke: {
        url: fields.invokeUrl,
        method: 'POST',
        body: '{{request}}',
        ...(fields.headerEnv === undefined || fields.headerEnv.length === 0
          ? {}
          : { headers: parseSecretBindings(fields.headerEnv, '--header-env') }),
      },
      extraction: {
        result_pointer: fields.responsePointer ?? '/output',
        ...(fields.errorPointer === undefined ? {} : { error_pointer: fields.errorPointer }),
        ...(fields.tracePointer === undefined ? {} : { trace_pointer: fields.tracePointer }),
      },
      ...(fields.shutdownUrl === undefined
        ? {}
        : { shutdown: { url: fields.shutdownUrl, method: 'POST' } }),
      stop_timeout_ms: parseDuration(fields.stopTimeout ?? '5s', '--stop-timeout'),
    };
  } else if (fields.jsonlCommand !== undefined) {
    transport = {
      kind: 'jsonl_bridge',
      lifecycle: 'per_run',
      argv: tokenizeCommand(fields.jsonlCommand),
      ...(fields.cwd === undefined ? {} : { cwd: fields.cwd }),
      ...processEnvironment,
      concurrency: fields.bridgeConcurrency ?? 'serial',
      cancellation_grace_ms: parseDuration(fields.cancellationGrace ?? '1s', '--cancel-grace'),
    };
  } else if (fields.streamUrl !== undefined) {
    transport = {
      kind: 'stream',
      lifecycle: 'external',
      framing: fields.streamFraming ?? 'sse',
      request: {
        url: fields.streamUrl,
        method: 'POST',
        body: '{{request}}',
        ...(fields.headerEnv === undefined || fields.headerEnv.length === 0
          ? {}
          : { headers: parseSecretBindings(fields.headerEnv, '--header-env') }),
      },
      ...(fields.eventName === undefined ? {} : { event_name: fields.eventName }),
      terminal_pointer: fields.terminalPointer ?? '/type',
      terminal_values: parseJsonValues(fields.terminalValues ?? ['"result"'], '--terminal-value'),
      result_pointer: fields.responsePointer ?? '/output',
      ...(fields.errorPointer === undefined ? {} : { error_pointer: fields.errorPointer }),
      ...(fields.tracePointer === undefined ? {} : { trace_pointer: fields.tracePointer }),
      ...(fields.incrementalOutputPointer === undefined
        ? {}
        : {
            incremental_output_pointer: fields.incrementalOutputPointer,
            incremental_output_mode: fields.incrementalOutputMode ?? 'text',
          }),
    };
  } else if (fields.webSocketUrl !== undefined) {
    const lifecycle = fields.webSocketLifecycle ?? 'per_run';
    transport = {
      kind: 'websocket',
      lifecycle,
      connection_mode:
        fields.connectionMode ?? (lifecycle === 'per_case' ? 'serial' : 'multiplexed'),
      framing: 'text_json',
      url: fields.webSocketUrl,
      ...(fields.headerEnv === undefined || fields.headerEnv.length === 0
        ? {}
        : { headers: parseSecretBindings(fields.headerEnv, '--header-env') }),
      ...(fields.webSocketSubprotocol === undefined
        ? {}
        : { subprotocol: fields.webSocketSubprotocol }),
      request_template: parseRequestTemplate(
        fields.requestTemplate ?? '{"request_id":"{{request_id}}","request":"{{request}}"}',
      ),
      request_id_pointer: fields.requestIdPointer ?? '/request_id',
      acknowledgement_pointer: fields.acknowledgementPointer ?? '/type',
      acknowledgement_values: parseJsonValues(
        fields.acknowledgementValues ?? ['"acknowledgement"'],
        '--acknowledgement-value',
      ),
      result_pointer: fields.responsePointer ?? '/output',
      error_pointer: fields.errorPointer ?? '/error',
      ...(fields.tracePointer === undefined ? {} : { trace_pointer: fields.tracePointer }),
      open_timeout_ms: parseDuration(fields.openTimeout ?? '10s', '--open-timeout'),
      message_idle_timeout_ms: parseDuration(fields.idleTimeout ?? '30s', '--idle-timeout'),
      attempt_timeout_ms: parseDuration(fields.attemptTimeout ?? '60s', '--attempt-timeout'),
      ping_interval_ms: parseDuration(fields.pingInterval ?? '15s', '--ping-interval'),
      close_timeout_ms: parseDuration(fields.closeTimeout ?? '5s', '--close-timeout'),
      retry_boundary: 'before_acknowledgement',
      replay_after_acknowledgement: false,
    };
  } else {
    transport = {
      kind: 'native_cli' as const,
      lifecycle: 'per_case' as const,
      argv:
        fields.argvJson === undefined
          ? tokenizeCommand(fields.nativeCommand ?? '')
          : parseArgvJson(fields.argvJson),
      ...(fields.cwd === undefined ? {} : { cwd: fields.cwd }),
      ...processEnvironment,
    };
  }
  const parsed = agentResourceSchema.safeParse({
    schema: AGENT_RESOURCE_SCHEMA_ID,
    id: fields.agentId,
    name,
    transport,
    ...(timeout === undefined ? {} : { timeouts: { attempt_ms: timeout } }),
    ...(fields.trace === undefined ? {} : { capabilities: { trace: fields.trace } }),
    ...(fields.headerEnv === undefined || fields.headerEnv.length === 0
      ? {}
      : {
          redaction: {
            headers: fields.headerEnv.map((binding) => binding.slice(0, binding.indexOf('='))),
          },
        }),
  });
  if (!parsed.success) {
    throw new AttestCliError('cli_usage', 'Agent values do not match the resource schema.', {
      details: { diagnostics: requestDiagnostics(parsed.error.issues) },
    });
  }
  assertSafeNativeAgentResource(parsed.data);
  return parsed.data;
};

export { createAgentResource };
