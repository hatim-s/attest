import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  AGENT_RESOURCE_SCHEMA_VERSION,
  COMMAND_REQUEST_SCHEMA_VERSION,
  agentResourceSchema,
  commandRequestSchema,
  type AgentResource,
  type CommandRequest,
  type SecretReference,
} from '@attest/contracts';

import { AttestCliError } from '../../errors.js';
import {
  CurlImportError,
  findCurlBodyFilePath,
  parseCurlCommand,
  type CurlImportPreview,
} from '../../import/curl/index.js';
import type { JsonValue } from '../../project/canonical-project.js';

type ReadInput = () => Promise<string>;

type AgentAddFields = {
  agentId: string;
  argvJson?: string;
  backgroundCommand?: string;
  bridgeConcurrency?: 'serial' | 'multiplexed';
  cancellationGrace?: string;
  cwd?: string;
  env?: readonly string[];
  errorPointer?: string;
  eventName?: string;
  headerEnv?: readonly string[];
  incrementalOutputMode?: 'text' | 'array';
  incrementalOutputPointer?: string;
  invokeUrl?: string;
  jsonlCommand?: string;
  name?: string;
  nativeCommand?: string;
  nativeHttp?: string;
  readinessHttp?: string;
  readinessStderr?: string;
  readinessTcp?: string;
  responsePointer?: string;
  shutdownUrl?: string;
  stopTimeout?: string;
  streamFraming?: 'sse' | 'jsonl';
  streamUrl?: string;
  terminalPointer?: string;
  terminalValues?: readonly string[];
  timeout?: string;
  trace?: boolean;
  tracePointer?: string;
};

const requestDiagnostics = (
  issues: readonly { message: string; path: PropertyKey[] }[],
): JsonValue => issues.map(({ message, path }) => ({ message, path: `/${path.join('/')}` }));

const MAX_REMOTE_JSON_BYTES = 1024 * 1024;
const MAX_CURL_BYTES = 1024 * 1024;
const REMOTE_JSON_TIMEOUT_MS = 10_000;

const isContainedPath = (root: string, candidate: string): boolean => {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (!isAbsolute(pathFromRoot) && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`))
  );
};

/** Fetches one bounded JSON document without following redirects or reflecting its URL. */
const readRemoteJson = async (source: string, path: string): Promise<string> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REMOTE_JSON_TIMEOUT_MS);
  try {
    const response = await fetch(source, { redirect: 'manual', signal: controller.signal });
    if (!response.ok) {
      throw new AttestCliError('cli_usage', 'The remote JSON source returned an error.', {
        path,
        details: { http_status: response.status },
      });
    }
    if (response.body === null) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_REMOTE_JSON_BYTES) {
        await reader.cancel();
        throw new AttestCliError('cli_usage', 'The remote JSON source exceeds the size limit.', {
          path,
          details: { maximum_bytes: MAX_REMOTE_JSON_BYTES },
        });
      }
      chunks.push(chunk.value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch (error: unknown) {
    if (error instanceof AttestCliError) throw error;
    throw new AttestCliError('cli_usage', 'Could not fetch the remote JSON source.', {
      path,
      hint: 'Use a reachable HTTP(S) JSON resource under 1 MiB.',
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }
};

/** Reads one JSON document while ensuring parse failures never echo sensitive source text. */
const readJsonDocument = async (
  source: string,
  workingDirectory: string,
  readStdin: ReadInput,
  path: string,
  allowRemote = false,
): Promise<unknown> => {
  let text: string;
  try {
    text = /^https?:\/\//u.test(source)
      ? allowRemote
        ? await readRemoteJson(source, path)
        : await Promise.reject(new Error('remote source is not allowed here'))
      : source === '-'
        ? await readStdin()
        : await readFile(resolve(workingDirectory, source), 'utf8');
  } catch (error: unknown) {
    if (error instanceof AttestCliError) throw error;
    throw new AttestCliError('cli_usage', 'Could not read the selected JSON source.', {
      path,
      hint: allowRemote
        ? 'Pass a readable JSON file, HTTP(S) URL, or `-` for stdin.'
        : 'Pass a readable JSON file or `-` for stdin.',
      cause: error,
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new AttestCliError('cli_usage', 'The selected input is not valid JSON.', {
      path,
      hint: 'Provide exactly one valid JSON document.',
      cause: error,
    });
  }
};

/** Loads and validates one versioned command request from a file or stdin. */
const readAgentCommandRequest = async <CommandName extends CommandRequest['command']>(
  source: string,
  command: CommandName,
  workingDirectory: string,
  readStdin: ReadInput,
): Promise<Extract<CommandRequest, { command: CommandName }>> => {
  const value = await readJsonDocument(source, workingDirectory, readStdin, '--from-json');
  const parsed = commandRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new AttestCliError('cli_usage', 'The command request does not match its schema.', {
      path: '--from-json',
      hint: `Provide one ${COMMAND_REQUEST_SCHEMA_VERSION} ${command} document.`,
      details: { diagnostics: requestDiagnostics(parsed.error.issues) },
    });
  }
  if (parsed.data.command !== command) {
    throw new AttestCliError('cli_usage', 'The command request targets another command.', {
      path: '/command',
      hint: `Set \`command\` to \`${command}\`.`,
    });
  }
  return parsed.data as Extract<CommandRequest, { command: CommandName }>;
};

/** Tokenizes a convenience command string into argv without expansion or shell execution. */
const tokenizeCommand = (value: string): string[] => {
  const argv: string[] = [];
  let token = '';
  let quote: 'single' | 'double' | undefined;
  let tokenStarted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote === 'single') {
      if (character === "'") quote = undefined;
      else token += character;
      tokenStarted = true;
      continue;
    }
    if (quote === 'double') {
      if (character === '"') quote = undefined;
      else if (character === '\\' && index + 1 < value.length) token += value[++index]!;
      else token += character;
      tokenStarted = true;
      continue;
    }
    if (character === "'") {
      quote = 'single';
      tokenStarted = true;
    } else if (character === '"') {
      quote = 'double';
      tokenStarted = true;
    } else if (character === '\\' && index + 1 < value.length) {
      token += value[++index]!;
      tokenStarted = true;
    } else if (/\s/u.test(character)) {
      if (tokenStarted) {
        argv.push(token);
        token = '';
        tokenStarted = false;
      }
    } else {
      token += character;
      tokenStarted = true;
    }
  }
  if (quote !== undefined) {
    throw new AttestCliError('cli_usage', 'The native command contains an unclosed quote.', {
      path: '--native-command',
      hint: 'Close the quote or use `--argv-json` for an unambiguous argv array.',
    });
  }
  if (tokenStarted) argv.push(token);
  if (argv.length === 0) {
    throw new AttestCliError('cli_missing_input', 'The native command argv cannot be empty.', {
      path: '--native-command',
      hint: 'Pass a command string or a non-empty `--argv-json` array.',
    });
  }
  return argv;
};

const parseArgvJson = (value: string): string[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new AttestCliError('cli_usage', '`--argv-json` is not valid JSON.', {
      path: '--argv-json',
      hint: 'Pass a JSON array of strings.',
      cause: error,
    });
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((entry) => typeof entry !== 'string')
  ) {
    throw new AttestCliError('cli_usage', '`--argv-json` must be a non-empty string array.', {
      path: '--argv-json',
      hint: 'Example: `--argv-json \'["node","./agent.mjs"]\'`.',
    });
  }
  return parsed as string[];
};

const parseDuration = (value: string, path = '--timeout'): number => {
  const match = /^(\d+)(ms|s|m)$/u.exec(value);
  const amount = match?.[1] === undefined ? 0 : Number(match[1]);
  const unit = match?.[2];
  const multiplier = unit === 'm' ? 60_000 : unit === 's' ? 1_000 : 1;
  const milliseconds = amount * multiplier;
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new AttestCliError('cli_usage', 'Duration must be a positive value.', {
      path,
      hint: 'Use an integer followed by ms, s, or m, such as `60s`.',
    });
  }
  return milliseconds;
};

const parseJsonValues = (values: readonly string[], path: string): JsonValue[] =>
  values.map((value) => {
    try {
      return JSON.parse(value) as JsonValue;
    } catch (error: unknown) {
      throw new AttestCliError('cli_usage', `${path} must contain valid JSON values.`, {
        path,
        hint: 'Quote strings as JSON, for example `--terminal-value \'"done"\'`.',
        cause: error,
      });
    }
  });

const parseTcpReadiness = (value: string): { host: string; port: number } => {
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/u.exec(value);
  const port = Number(match?.[2]);
  if (match?.[1] === undefined || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new AttestCliError('cli_usage', '--readiness-tcp must be HOST:PORT.', {
      path: '--readiness-tcp',
      hint: 'Example: `--readiness-tcp 127.0.0.1:8787`.',
    });
  }
  return { host: match[1].replace(/^\[|\]$/gu, ''), port };
};

const parseSecretBindings = (
  values: readonly string[],
  path: string,
): Record<string, SecretReference> => {
  const bindings: Record<string, SecretReference> = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    const target = value.slice(0, separator).trim();
    const source = value.slice(separator + 1).trim();
    if (separator <= 0 || target.length === 0 || source.length === 0) {
      throw new AttestCliError('cli_usage', `Invalid secret binding: ${value}.`, {
        path,
        hint: 'Use TARGET_NAME=SOURCE_ENV; only the environment variable name is stored.',
      });
    }
    bindings[target] = { from_env: source };
  }
  return bindings;
};

const SENSITIVE_NAME = /authorization|cookie|password|secret|token|api[-_]?key/iu;

const isNativeEnvelopeHttp = (
  transport: Extract<AgentResource['transport'], { kind: 'http' }>,
): boolean => transport.response_mode === 'attest_envelope';

const findSensitiveBodyField = (value: JsonValue, path = ''): string | undefined => {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findSensitiveBodyField(value[index]!, `${path}/${String(index)}`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value === null || typeof value !== 'object') return undefined;
  for (const [name, entry] of Object.entries(value)) {
    if (SENSITIVE_NAME.test(name)) return `${path}/${name}`;
    const found = findSensitiveBodyField(entry, `${path}/${name}`);
    if (found !== undefined) return found;
  }
  return undefined;
};

const assertSafeHttpTemplate = (
  request: Extract<AgentResource['transport'], { kind: 'http' }>['request'],
  path: string,
): URL => {
  const separator = request.url.indexOf('://');
  const authorityStart = separator + 3;
  const authorityEnd = request.url.slice(authorityStart).search(/[/?#]/u);
  const authority = request.url.slice(
    authorityStart,
    authorityEnd < 0 ? undefined : authorityStart + authorityEnd,
  );
  if (
    separator <= 0 ||
    request.url.slice(0, authorityStart).includes('{{') ||
    authority.includes('{{')
  ) {
    throw new AttestCliError(
      'project_invalid',
      'Mapped HTTP URL placeholders are allowed only in path or query components.',
      { path },
    );
  }
  let url: URL;
  try {
    url = new URL(request.url.replaceAll(/\{\{[^}]+\}\}/gu, 'placeholder'));
  } catch {
    throw new AttestCliError('project_invalid', 'Mapped HTTP URL is invalid.', { path });
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0 ||
    url.search.length > 0
  ) {
    throw new AttestCliError('project_invalid', 'Mapped HTTP URL contains an unsafe component.', {
      path,
      hint: 'Keep query mappings separate and remove credentials or fragments from the URL.',
    });
  }
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (SENSITIVE_NAME.test(name) && typeof value === 'string') {
      throw new AttestCliError('project_invalid', 'Sensitive HTTP headers must use references.', {
        path: `${path}/headers/${name}`,
      });
    }
  }
  for (const [name, value] of Object.entries(request.query ?? {})) {
    if (SENSITIVE_NAME.test(name) && typeof value === 'string') {
      throw new AttestCliError(
        'project_invalid',
        'Sensitive HTTP query values must use references.',
        {
          path: `${path}/query/${name}`,
        },
      );
    }
  }
  const sensitiveBody =
    request.body === undefined ? undefined : findSensitiveBodyField(request.body);
  if (sensitiveBody !== undefined) {
    throw new AttestCliError('project_invalid', 'Mapped HTTP bodies cannot contain credentials.', {
      path: `${path}/body${sensitiveBody}`,
      hint: 'Move credentials to an environment-backed header or query reference.',
    });
  }
  return url;
};

/** Rejects authored credentials and runtime policies outside the implemented adapter slice. */
const assertSafeNativeAgentResource = (agent: AgentResource): void => {
  const transport = agent.transport;
  const kind = transport.kind;
  const unsupportedTimeoutFields =
    kind === 'native_cli' || (kind === 'http' && transport.response_mode === 'attest_envelope')
      ? ['connect_ms', 'first_byte_ms', 'idle_ms', 'run_ms']
      : kind === 'http' || kind === 'polling' || kind === 'stream'
        ? ['run_ms']
        : kind === 'jsonl_bridge'
          ? ['connect_ms']
          : [];
  const unsupportedTimeout = unsupportedTimeoutFields.find(
    (field) =>
      agent.timeouts?.[field as keyof NonNullable<AgentResource['timeouts']>] !== undefined,
  );
  const unsupportedLimitFields =
    kind === 'native_cli' || (kind === 'http' && transport.response_mode === 'attest_envelope')
      ? ['request_bytes', 'event_count', 'event_bytes', 'total_evidence_bytes']
      : kind === 'http' || kind === 'polling'
        ? ['event_count', 'event_bytes', 'total_evidence_bytes']
        : kind === 'background_cli'
          ? ['event_count', 'event_bytes']
          : kind === 'stream'
            ? ['response_bytes']
            : [];
  const unsupportedLimit = unsupportedLimitFields.find(
    (field) => agent.limits?.[field as keyof NonNullable<AgentResource['limits']>] !== undefined,
  );
  if (unsupportedTimeout !== undefined || unsupportedLimit !== undefined) {
    const section = unsupportedTimeout === undefined ? 'limits' : 'timeouts';
    const field = unsupportedTimeout ?? unsupportedLimit!;
    throw new AttestCliError(
      'project_invalid',
      'This runtime policy is unsupported by the adapter.',
      {
        path: `/agent/${section}/${field}`,
        hint: 'Remove the unsupported phase or select an adapter that enforces it.',
      },
    );
  }
  if (
    (kind === 'native_cli' && agent.retry !== undefined && agent.retry.backoff.kind !== 'none') ||
    (kind === 'jsonl_bridge' && (agent.retry?.retries ?? 0) > 0)
  ) {
    throw new AttestCliError('project_invalid', 'This retry policy is unsafe for the adapter.', {
      path: '/agent/retry',
      hint:
        kind === 'jsonl_bridge'
          ? 'Set retries to zero; a sent bridge request is never replayed.'
          : 'Use deterministic no-backoff retries for native per-case probes.',
    });
  }
  if (
    transport.kind === 'native_cli' ||
    transport.kind === 'background_cli' ||
    transport.kind === 'jsonl_bridge'
  ) {
    const argv = transport.kind === 'background_cli' ? transport.start_argv : transport.argv;
    for (const position of agent.redaction?.argv_positions ?? []) {
      if (position >= argv.length) {
        throw new AttestCliError('project_invalid', 'An argv redaction position is out of range.', {
          path: `/agent/redaction/argv_positions/${position}`,
        });
      }
    }
    const sensitivePosition = argv.findIndex((argument) => SENSITIVE_NAME.test(argument));
    if (sensitivePosition >= 0) {
      throw new AttestCliError(
        'project_invalid',
        'Native argv cannot contain credential-like literals.',
        {
          path: `/agent/transport/argv/${sensitivePosition}`,
          hint: 'Pass credentials through an environment secret reference.',
        },
      );
    }
    if (transport.kind === 'jsonl_bridge') return;
    if (transport.kind === 'native_cli') return;

    let pattern: RegExp | undefined;
    if (transport.readiness.kind === 'stderr') {
      try {
        pattern = new RegExp(transport.readiness.pattern, 'u');
      } catch (error: unknown) {
        throw new AttestCliError('project_invalid', 'Background readiness regex is invalid.', {
          path: '/agent/transport/readiness/pattern',
          cause: error,
        });
      }
    }
    void pattern;
    const requests = [
      { request: transport.invoke, path: '/agent/transport/invoke' },
      ...(transport.shutdown === undefined
        ? []
        : [{ request: transport.shutdown, path: '/agent/transport/shutdown' }]),
    ];
    const readinessUrl =
      transport.readiness.kind === 'http'
        ? assertSafeHttpTemplate(
            { url: transport.readiness.url, method: 'GET' },
            '/agent/transport/readiness/url',
          )
        : undefined;
    for (const { request, path } of requests) {
      const url = assertSafeHttpTemplate(request, path);
      if (!['localhost', '::1'].includes(url.hostname) && !url.hostname.startsWith('127.')) {
        throw new AttestCliError(
          'project_invalid',
          'Background agents require loopback HTTP endpoints.',
          {
            path: `${path}/url`,
          },
        );
      }
    }
    if (
      readinessUrl !== undefined &&
      !['localhost', '::1'].includes(readinessUrl.hostname) &&
      !readinessUrl.hostname.startsWith('127.')
    ) {
      throw new AttestCliError('project_invalid', 'Background readiness requires a loopback URL.', {
        path: '/agent/transport/readiness/url',
      });
    }
    if (
      transport.readiness.kind === 'tcp' &&
      !['localhost', '::1'].includes(transport.readiness.host) &&
      !transport.readiness.host.startsWith('127.')
    ) {
      throw new AttestCliError(
        'project_invalid',
        'Background TCP readiness requires a loopback host.',
        {
          path: '/agent/transport/readiness/host',
        },
      );
    }
    return;
  }
  if (transport.kind === 'websocket') {
    throw new AttestCliError('project_invalid', 'This transport belongs to a later CLI item.', {
      path: '/agent/transport/kind',
      hint: 'WebSockets are CLI2.12; CLI2.11 supports HTTP SSE and JSONL streams.',
    });
  }
  const request = transport.kind === 'polling' ? transport.submit : transport.request;
  const requestPath = `/agent/transport/${transport.kind === 'polling' ? 'submit' : 'request'}`;
  if (
    transport.kind === 'http' &&
    transport.response_mode === 'attest_envelope' &&
    (request.method !== 'POST' ||
      request.body !== undefined ||
      request.query !== undefined ||
      transport.extraction.result_pointer !== '' ||
      transport.extraction.error_pointer !== undefined ||
      transport.extraction.trace_pointer !== undefined ||
      transport.extraction.remote_job_id_pointer !== undefined)
  ) {
    throw new AttestCliError('project_invalid', 'Native-envelope HTTP mapping is inconsistent.', {
      path: '/agent/transport/response_mode',
      hint: 'Use the canonical POST envelope shape or select mapped response mode.',
    });
  }
  const origin = assertSafeHttpTemplate(request, requestPath);
  if (transport.kind === 'polling' && transport.status_url_template !== undefined) {
    const status = assertSafeHttpTemplate(
      { url: transport.status_url_template.replaceAll('{{job_id}}', 'job'), method: 'GET' },
      '/agent/transport/status_url_template',
    );
    if (status.origin !== origin.origin) {
      throw new AttestCliError('project_invalid', 'Polling status URL must retain submit origin.', {
        path: '/agent/transport/status_url_template',
      });
    }
  }
  if (
    transport.kind === 'stream' &&
    transport.incremental_output_pointer !== undefined &&
    transport.incremental_output_mode === undefined
  ) {
    throw new AttestCliError(
      'project_invalid',
      'Streaming accumulation requires an explicit mode.',
      {
        path: '/agent/transport/incremental_output_mode',
      },
    );
  }
  for (const name of agent.redaction?.headers ?? []) {
    if (
      !Object.keys(request.headers ?? {}).some(
        (header) => header.toLowerCase() === name.toLowerCase(),
      )
    ) {
      throw new AttestCliError('project_invalid', 'A header redaction target does not exist.', {
        path: `/agent/redaction/headers/${name}`,
      });
    }
  }
  for (const name of agent.redaction?.query ?? []) {
    if (!Object.hasOwn(request.query ?? {}, name)) {
      throw new AttestCliError('project_invalid', 'A query redaction target does not exist.', {
        path: `/agent/redaction/query/${name}`,
      });
    }
  }
};

/** Normalizes non-interactive or wizard-populated add fields into one v2 resource. */
const createAgentResource = (fields: AgentAddFields): AgentResource => {
  const selected = [
    fields.argvJson,
    fields.nativeCommand,
    fields.nativeHttp,
    fields.backgroundCommand,
    fields.jsonlCommand,
    fields.streamUrl,
  ].filter((value) => value !== undefined);
  if (selected.length !== 1) {
    throw new AttestCliError(
      selected.length === 0 ? 'cli_missing_input' : 'cli_usage',
      'Select exactly one agent transport.',
      {
        path: '--argv-json',
        hint: 'Pass one of `--argv-json`, `--native-command`, `--native-http`, `--background-command`, `--jsonl-command`, or `--stream-url`.',
      },
    );
  }
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
    schema: AGENT_RESOURCE_SCHEMA_VERSION,
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
    throw new AttestCliError('cli_usage', 'Agent values do not match the v2 resource schema.', {
      details: { diagnostics: requestDiagnostics(parsed.error.issues) },
    });
  }
  assertSafeNativeAgentResource(parsed.data);
  return parsed.data;
};

/** Imports one native v2 agent resource without preserving its source bytes or literal secrets. */
const readImportedAgentResource = async (
  source: string,
  agentId: string,
  name: string | undefined,
  workingDirectory: string,
  readStdin: ReadInput,
): Promise<AgentResource> => {
  const value = await readJsonDocument(source, workingDirectory, readStdin, 'source', true);
  const parsed = agentResourceSchema.safeParse(value);
  if (!parsed.success) {
    throw new AttestCliError('cli_usage', 'Imported agent JSON does not match its schema.', {
      path: 'source',
      details: { diagnostics: requestDiagnostics(parsed.error.issues) },
    });
  }
  const resource = { ...parsed.data, id: agentId, name: name?.trim() || parsed.data.name };
  assertSafeNativeAgentResource(resource);
  return resource;
};

type CurlAgentImportRequest = Extract<
  CommandRequest,
  { command: 'agent.import'; source_type: 'curl' }
>;

/** Reads one bounded local/stdin cURL document without permitting remote source indirection. */
const readCurlDocument = async (
  source: string,
  workingDirectory: string,
  readStdin: ReadInput,
): Promise<string> => {
  let text: string;
  try {
    if (/^https?:\/\//u.test(source)) throw new Error('remote cURL sources are not supported');
    text =
      source === '-'
        ? await readStdin()
        : await readFile(resolve(workingDirectory, source), 'utf8');
  } catch (error: unknown) {
    throw new AttestCliError('cli_usage', 'Could not read the selected cURL source.', {
      path: 'source',
      hint: 'Pass a local cURL file or `-` for stdin.',
      cause: error,
    });
  }
  if (Buffer.byteLength(text) > MAX_CURL_BYTES) {
    throw new AttestCliError('cli_usage', 'The cURL source exceeds the size limit.', {
      path: 'source',
      details: { maximum_bytes: MAX_CURL_BYTES },
    });
  }
  return text;
};

/** Reads one project-contained cURL data file through a no-follow bounded descriptor. */
const readCurlBodyFile = async (
  path: string,
  projectRoot: string,
  maximumBytes: number,
): Promise<string> => {
  const candidate = resolve(projectRoot, path);
  if (path.length === 0 || isAbsolute(path) || !isContainedPath(projectRoot, candidate)) {
    throw new AttestCliError('cli_usage', 'The cURL body file must be inside the project.', {
      path: 'source',
      details: { diagnostic: 'file_body_outside_project' },
    });
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    const [resolvedPath, pathMetadata] = await Promise.all([realpath(candidate), lstat(candidate)]);
    if (
      !metadata.isFile() ||
      !isContainedPath(projectRoot, resolvedPath) ||
      pathMetadata.isSymbolicLink() ||
      pathMetadata.dev !== metadata.dev ||
      pathMetadata.ino !== metadata.ino
    ) {
      throw new Error('body file must retain one project-contained regular-file identity');
    }
    if (metadata.size > maximumBytes) throw new Error('body file exceeds the request cap');
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - bytes));
      const read = await handle.read(chunk, 0, chunk.length, bytes);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
      if (bytes > maximumBytes) throw new Error('body file exceeds the request cap');
      chunks.push(chunk.subarray(0, read.bytesRead));
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
  } catch (error: unknown) {
    throw new AttestCliError('cli_usage', 'Could not safely read the cURL body file.', {
      path: 'source',
      hint: 'Use one project-contained regular UTF-8 file within the request byte cap.',
      details: { diagnostic: 'unsafe_file_body' },
      cause: error,
    });
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

/** Converts one inert cURL request into a canonical direct or polling agent resource. */
const createImportedCurlAgentResource = async (
  request: CurlAgentImportRequest,
  source: string,
  projectRoot: string,
): Promise<{ agent: AgentResource; preview: CurlImportPreview }> => {
  let parsedCurl: ReturnType<typeof parseCurlCommand>;
  try {
    const bodyFilePath = findCurlBodyFilePath(source);
    const bodyFile =
      bodyFilePath === undefined
        ? undefined
        : {
            path: bodyFilePath,
            text: await readCurlBodyFile(
              bodyFilePath,
              projectRoot,
              Math.min(request.limits?.request_bytes ?? MAX_CURL_BYTES, MAX_CURL_BYTES),
            ),
          };
    parsedCurl = parseCurlCommand(source, {
      bodyFile,
      headerSecrets: request.header_env,
      querySecrets: request.query_env,
      placeholders: request.placeholders?.map((mapping) => ({
        targetPointer: mapping.target_pointer,
        inputPointer: mapping.input_pointer,
      })),
    });
  } catch (error: unknown) {
    if (error instanceof CurlImportError) {
      throw new AttestCliError('cli_usage', error.message, {
        path: 'source',
        hint: 'Use literal HTTP request data and explicit environment-backed secret mappings.',
        details: { diagnostics: error.diagnostics },
      });
    }
    throw error;
  }
  const transport =
    request.polling === undefined
      ? {
          kind: 'http' as const,
          lifecycle: 'external' as const,
          response_mode: 'mapped' as const,
          request: parsedCurl.request,
          extraction: request.extraction,
        }
      : {
          kind: 'polling' as const,
          lifecycle: 'external' as const,
          submit: parsedCurl.request,
          extraction: request.extraction,
          ...request.polling,
        };
  const parsed = agentResourceSchema.safeParse({
    schema: AGENT_RESOURCE_SCHEMA_VERSION,
    id: request.as,
    name: request.name?.trim() || request.as,
    transport,
    ...(request.timeouts === undefined ? {} : { timeouts: request.timeouts }),
    ...(request.retry === undefined ? {} : { retry: request.retry }),
    ...(request.limits === undefined ? {} : { limits: request.limits }),
    ...((request.header_env === undefined || Object.keys(request.header_env).length === 0) &&
    (request.query_env === undefined || Object.keys(request.query_env).length === 0)
      ? {}
      : {
          redaction: {
            ...(request.header_env === undefined
              ? {}
              : { headers: Object.keys(request.header_env) }),
            ...(request.query_env === undefined ? {} : { query: Object.keys(request.query_env) }),
          },
        }),
  });
  if (!parsed.success) {
    throw new AttestCliError('cli_usage', 'The cURL mapping does not match the agent schema.', {
      path: 'source',
      details: { diagnostics: requestDiagnostics(parsed.error.issues) },
    });
  }
  assertSafeNativeAgentResource(parsed.data);
  return { agent: parsed.data, preview: parsedCurl.preview };
};

export {
  assertSafeNativeAgentResource,
  createImportedCurlAgentResource,
  createAgentResource,
  parseArgvJson,
  parseDuration,
  readAgentCommandRequest,
  readCurlDocument,
  readCurlBodyFile,
  readImportedAgentResource,
  tokenizeCommand,
  type AgentAddFields,
  type ReadInput,
};
