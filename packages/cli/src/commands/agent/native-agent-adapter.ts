import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, relative, resolve, sep } from 'node:path';

import {
  AGENT_PROTOCOL,
  type AgentRequest,
  type AgentResource,
  type AgentTarget,
  type JsonValue,
  type SecretReference,
} from '@attest/contracts';
import {
  AgentInvocationError,
  invokeAgent,
  invokeMappedHttpAgent,
  invokeStreamingAgent,
  redactTransportText,
  startBackgroundAgent,
  startJsonlBridgeAgent,
  type BackgroundAgentResource,
  type HttpAgentResource,
  type InvocationResult,
  type JsonlBridgeAgentResource,
  type StoredCaseExecution,
  type StoredAttempt,
  type StreamAgentResource,
} from '@attest/core';

import { AttestCliError } from '../../errors.js';

const CONNECTION_TEST_RUN_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const DEFAULT_OUTPUT_CAP_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const REDACTED = '[REDACTED]';

type NativeAgentTestOptions = {
  agent: AgentResource;
  input: JsonValue;
  onProgress?: (message: string) => void;
  onExecution?: (execution: StoredCaseExecution) => Promise<void>;
  projectRoot: string;
  runId?: string;
  secretFileObserver?: (path: string) => Promise<void>;
  signal?: AbortSignal;
};

type ResolvedNativeAgent = {
  backgroundAgent?: BackgroundAgentResource;
  backgroundInvokeHeaders?: Record<string, string>;
  backgroundInvokeQuery?: Record<string, string>;
  backgroundShutdownHeaders?: Record<string, string>;
  backgroundShutdownQuery?: Record<string, string>;
  cwd?: string;
  env?: Record<string, string>;
  httpHeaders?: Record<string, string>;
  httpQuery?: Record<string, string>;
  jsonlBridgeAgent?: JsonlBridgeAgentResource;
  mappedAgent?: HttpAgentResource;
  secrets: string[];
  streamAgent?: StreamAgentResource;
  target?: AgentTarget;
};

const isContainedPath = (root: string, candidate: string): boolean => {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (!isAbsolute(pathFromRoot) && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`))
  );
};

/** Reads a secret reference at invocation time without returning its source path or value. */
const readSecretReference = async (
  reference: SecretReference,
  projectRoot: string,
  observer?: (path: string) => Promise<void>,
): Promise<string> => {
  if ('from_env' in reference) {
    const value = process.env[reference.from_env];
    if (value === undefined) {
      throw new AttestCliError('invocation_failed', 'A referenced environment secret is missing.', {
        path: reference.from_env,
        hint: 'Set the referenced environment variable and retry the connection test.',
      });
    }
    return value;
  }

  const candidate = resolve(projectRoot, reference.from_file);
  if (!isContainedPath(projectRoot, candidate)) {
    throw new AttestCliError('invocation_failed', 'A secret file is outside the project.', {
      path: reference.from_file,
      hint: 'Use a project-contained secret file or an environment reference.',
    });
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
      throw new Error('secret file must be a private regular file');
    }
    await observer?.(reference.from_file);
    const [resolvedPath, pathMetadata] = await Promise.all([realpath(candidate), lstat(candidate)]);
    if (
      !isContainedPath(projectRoot, resolvedPath) ||
      pathMetadata.dev !== metadata.dev ||
      pathMetadata.ino !== metadata.ino
    ) {
      throw new Error('secret file identity changed while opening');
    }
    // Read from the validated descriptor so a path replacement cannot redirect the secret read.
    return await handle.readFile('utf8');
  } catch (error: unknown) {
    throw new AttestCliError('invocation_failed', 'A referenced secret file is unavailable.', {
      path: reference.from_file,
      hint: 'Use a project-contained regular file with group/world permissions removed.',
      cause: error,
    });
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

/** Builds the minimum safe inherited environment used by the hardened native CLI invoker. */
const createBaseEnvironment = (): Record<string, string> => ({
  PATH: (process.env.PATH ?? '')
    .split(delimiter)
    .filter((entry) => isAbsolute(entry))
    .join(delimiter),
  LC_ALL: 'C',
  TMPDIR: tmpdir(),
});

/** Resolves an authored cwd through realpath and rejects symlink escapes from the project. */
const resolveProcessCwd = async (projectRoot: string, cwd = '.'): Promise<string> => {
  const candidate = resolve(projectRoot, cwd);
  try {
    const resolved = await realpath(candidate);
    if (!isContainedPath(projectRoot, resolved)) throw new Error('cwd escapes project');
    return resolved;
  } catch (error: unknown) {
    throw new AttestCliError('invocation_failed', 'The managed process cwd is unavailable.', {
      path: cwd,
      hint: 'Use an existing project-contained directory without symlink traversal.',
      cause: error,
    });
  }
};

/** Resolves only explicit relative argv paths against the authored cwd; no shell parsing occurs. */
const resolveProcessArgv = (argv: readonly string[], cwd: string): string[] =>
  argv.map((argument) =>
    isAbsolute(argument) || !(argument === '.' || argument === '..' || /^\.\.?\//u.test(argument))
      ? argument
      : resolve(cwd, argument),
  );

/** Materializes runtime-only environment secret references for one managed child. */
const resolveProcessEnvironment = async (
  references: Readonly<Record<string, SecretReference>> | undefined,
  projectRoot: string,
  observer: ((path: string) => Promise<void>) | undefined,
): Promise<{ env: Record<string, string>; secrets: string[] }> => {
  const env = createBaseEnvironment();
  const secrets: string[] = [];
  for (const [name, reference] of Object.entries(references ?? {})) {
    const value = await readSecretReference(reference, projectRoot, observer);
    env[name] = value;
    secrets.push(value);
  }
  return { env, secrets };
};

/** Resolves request-template secret references without changing the authored resource. */
const resolveHttpSecrets = async (
  requests: readonly {
    headers?: Record<string, string | SecretReference>;
    query?: Record<string, string | SecretReference>;
  }[],
  projectRoot: string,
  observer: ((path: string) => Promise<void>) | undefined,
): Promise<{
  headers: Record<string, string>;
  query: Record<string, string>;
  secrets: string[];
}> => {
  const headers: Record<string, string> = {};
  const query: Record<string, string> = {};
  const secrets: string[] = [];
  for (const request of requests) {
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      const resolved =
        typeof value === 'string' ? value : await readSecretReference(value, projectRoot, observer);
      headers[name] = resolved;
      if (typeof value !== 'string') secrets.push(resolved);
    }
    for (const [name, value] of Object.entries(request.query ?? {})) {
      const resolved =
        typeof value === 'string' ? value : await readSecretReference(value, projectRoot, observer);
      query[name] = resolved;
      if (typeof value !== 'string') secrets.push(resolved);
    }
  }
  return { headers, query, secrets };
};

/** Resolves runtime-only secret references into an ephemeral native transport target. */
const resolveNativeAgent = async (
  agent: AgentResource,
  projectRoot: string,
  observer?: (path: string) => Promise<void>,
): Promise<ResolvedNativeAgent> => {
  if (
    agent.transport.kind === 'native_cli' ||
    agent.transport.kind === 'background_cli' ||
    agent.transport.kind === 'jsonl_bridge'
  ) {
    const transport = agent.transport;
    const cwd = await resolveProcessCwd(projectRoot, transport.cwd);
    const resolvedEnvironment = await resolveProcessEnvironment(
      transport.env,
      projectRoot,
      observer,
    );
    const authoredArgv =
      transport.kind === 'background_cli' ? transport.start_argv : transport.argv;
    const argv = resolveProcessArgv(authoredArgv, cwd);
    for (const position of agent.redaction?.argv_positions ?? []) {
      const value = argv[position];
      if (value === undefined) {
        throw new AttestCliError('project_invalid', 'An argv redaction position is out of range.', {
          path: `/agents/${agent.id}/redaction/argv_positions`,
        });
      }
      resolvedEnvironment.secrets.push(value);
    }
    if (transport.kind === 'native_cli') {
      return {
        cwd,
        env: resolvedEnvironment.env,
        secrets: resolvedEnvironment.secrets,
        target: { type: 'cli', command: argv },
      };
    }
    if (transport.kind === 'jsonl_bridge') {
      return {
        cwd,
        env: resolvedEnvironment.env,
        jsonlBridgeAgent: {
          ...agent,
          transport: { ...transport, argv },
        },
        secrets: resolvedEnvironment.secrets,
      };
    }
    const invoke = await resolveHttpSecrets([transport.invoke], projectRoot, observer);
    const shutdown =
      transport.shutdown === undefined
        ? { headers: {}, query: {}, secrets: [] }
        : await resolveHttpSecrets([transport.shutdown], projectRoot, observer);
    return {
      backgroundAgent: {
        ...agent,
        transport: { ...transport, start_argv: argv },
      },
      cwd,
      env: resolvedEnvironment.env,
      backgroundInvokeHeaders: invoke.headers,
      backgroundInvokeQuery: invoke.query,
      backgroundShutdownHeaders: shutdown.headers,
      backgroundShutdownQuery: shutdown.query,
      secrets: [...resolvedEnvironment.secrets, ...invoke.secrets, ...shutdown.secrets],
    };
  }

  if (
    agent.transport.kind === 'http' ||
    agent.transport.kind === 'polling' ||
    agent.transport.kind === 'stream'
  ) {
    const transport = agent.transport;
    const request = transport.kind === 'polling' ? transport.submit : transport.request;
    const nativeEnvelope =
      transport.kind === 'http' && transport.response_mode === 'attest_envelope';
    const headers: Record<string, string> = {};
    const query: Record<string, string> = {};
    const secrets: string[] = [];
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      if (typeof value === 'string') {
        headers[name] = value;
      } else {
        const resolved = await readSecretReference(value, projectRoot, observer);
        headers[name] = resolved;
        secrets.push(resolved);
      }
      if (agent.redaction?.headers?.some((header) => header.toLowerCase() === name.toLowerCase())) {
        secrets.push(headers[name]);
      }
    }
    for (const [name, value] of Object.entries(request.query ?? {})) {
      if (typeof value === 'string') query[name] = value;
      else {
        query[name] = await readSecretReference(value, projectRoot, observer);
        secrets.push(query[name]);
      }
      if (agent.redaction?.query?.includes(name)) secrets.push(query[name]);
    }
    if (nativeEnvelope) {
      return { httpHeaders: headers, secrets, target: { type: 'http', url: request.url } };
    }
    if (transport.kind === 'stream') {
      return {
        httpHeaders: headers,
        httpQuery: query,
        secrets,
        streamAgent: agent as StreamAgentResource,
      };
    }
    return {
      httpHeaders: headers,
      httpQuery: query,
      mappedAgent: agent as HttpAgentResource,
      secrets,
    };
  }

  throw new AttestCliError(
    'project_invalid',
    `Agent ${agent.id} uses a transport that belongs to a later CLI item.`,
    {
      path: `/agents/${agent.id}/transport/kind`,
      hint: 'CLI2.11 supports native_cli, background_cli, jsonl_bridge, HTTP, polling, and stream.',
    },
  );
};

/** Rejects authored policies that the selected bounded adapter cannot enforce. */
const assertSupportedProbePolicy = (agent: AgentResource): void => {
  const kind = agent.transport.kind;
  const unsupportedTimeoutFields =
    kind === 'native_cli'
      ? ['connect_ms', 'first_byte_ms', 'idle_ms', 'run_ms']
      : kind === 'http' || kind === 'polling'
        ? ['run_ms']
        : kind === 'jsonl_bridge'
          ? ['connect_ms']
          : [];
  const unsupportedTimeout = unsupportedTimeoutFields.find(
    (field) =>
      agent.timeouts?.[field as keyof NonNullable<AgentResource['timeouts']>] !== undefined,
  );
  if (unsupportedTimeout !== undefined) {
    throw new AttestCliError(
      'project_invalid',
      'This timeout phase is not supported by the adapter.',
      {
        path: `/agents/${agent.id}/timeouts/${unsupportedTimeout}`,
        hint: 'Remove the unsupported phase or select a lifecycle that owns it.',
      },
    );
  }
  if (
    (kind === 'native_cli' && agent.retry !== undefined && agent.retry.backoff.kind !== 'none') ||
    (kind === 'jsonl_bridge' && (agent.retry?.retries ?? 0) > 0)
  ) {
    throw new AttestCliError(
      'project_invalid',
      'Retry backoff is not supported by native probes.',
      {
        path: `/agents/${agent.id}/retry/backoff`,
        hint:
          kind === 'jsonl_bridge'
            ? 'Set retries to zero; sent bridge requests are not replayed.'
            : 'Use deterministic no-backoff retries for a native connection probe.',
      },
    );
  }
  const unsupportedLimitFields =
    kind === 'native_cli'
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
  if (unsupportedLimit !== undefined) {
    throw new AttestCliError(
      'project_invalid',
      'This evidence limit is not supported by the adapter.',
      {
        path: `/agents/${agent.id}/limits/${unsupportedLimit}`,
        hint: 'Remove the limit or use the adapter-specific request, response, or event cap.',
      },
    );
  }
};

const redactString = (value: string, secrets: readonly string[]): string =>
  redactTransportText(value, secrets);

/** Recursively removes runtime secret values and sensitive named fields from probe evidence. */
const redactProbeValue = (value: unknown, secrets: readonly string[]): JsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => redactProbeValue(entry, secrets));
  if (typeof value !== 'object') return null;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [
        key,
        /authorization|cookie|password|secret|token|api[-_]?key/iu.test(key)
          ? REDACTED
          : redactProbeValue(entry, secrets),
      ]),
  );
};

const redactStored = <Value>(value: Value, secrets: readonly string[]): Value =>
  redactProbeValue(value, secrets) as unknown as Value;

const invocationAttempts = (attempts: InvocationResult['attempts']): JsonValue =>
  attempts.map((attempt, index) => ({
    attempt: index + 1,
    duration_ms: attempt.durationMs,
    status: attempt.status,
    ...(attempt.status === 'invocation_error' ? { invocation_code: attempt.error.code } : {}),
    diagnostics: attempt.diagnostics,
    raw_excerpt: attempt.rawExcerpt,
    warnings: attempt.warnings,
  })) as JsonValue;

const storedAttempts = (
  attempts: InvocationResult['attempts'],
  secrets: readonly string[],
): StoredAttempt[] =>
  attempts.map((attempt) => ({
    status: attempt.status,
    diagnostics: redactStored(attempt.diagnostics, secrets),
    durationMs: attempt.durationMs,
    rawExcerpt:
      attempt.rawExcerpt === undefined ? undefined : redactStored(attempt.rawExcerpt, secrets),
    warnings: redactStored(attempt.warnings, secrets),
    ...(attempt.status === 'invocation_error'
      ? {
          errorCode: attempt.error.code,
          errorMessage: redactString(attempt.error.message, secrets),
        }
      : {}),
  })) as unknown as StoredAttempt[];

/** Runs one supported adapter probe and returns only bounded, redacted evidence. */
const testNativeAgentConnection = async (options: NativeAgentTestOptions): Promise<JsonValue> => {
  assertSupportedProbePolicy(options.agent);
  options.onProgress?.(`Testing agent ${options.agent.id}...`);
  const resolved = await resolveNativeAgent(
    options.agent,
    options.projectRoot,
    options.secretFileObserver,
  );
  const request: AgentRequest = {
    protocol: AGENT_PROTOCOL,
    run_id: options.runId ?? CONNECTION_TEST_RUN_ID,
    case_id: 'connection-test',
    input: options.input,
  };
  const startedAt = new Date().toISOString();
  let invocation: InvocationResult;
  const managedStartupStarted = performance.now();
  try {
    if (resolved.backgroundAgent !== undefined) {
      const session = await startBackgroundAgent(resolved.backgroundAgent, {
        cwd: resolved.cwd ?? options.projectRoot,
        env: resolved.env ?? createBaseEnvironment(),
        invokeHeaders: resolved.backgroundInvokeHeaders,
        invokeQuery: resolved.backgroundInvokeQuery,
        secrets: resolved.secrets,
        shutdownHeaders: resolved.backgroundShutdownHeaders,
        shutdownQuery: resolved.backgroundShutdownQuery,
        signal: options.signal,
      });
      try {
        invocation = await session.invoke(request, options.signal);
      } finally {
        await session.close();
      }
    } else if (resolved.jsonlBridgeAgent !== undefined) {
      const session = await startJsonlBridgeAgent(resolved.jsonlBridgeAgent, {
        cwd: resolved.cwd ?? options.projectRoot,
        env: resolved.env ?? createBaseEnvironment(),
        secrets: resolved.secrets,
        signal: options.signal,
      });
      try {
        invocation = await session.invoke(request, options.signal);
      } finally {
        await session.close();
      }
    } else if (resolved.streamAgent !== undefined) {
      invocation = await invokeStreamingAgent(resolved.streamAgent, request, {
        headers: resolved.httpHeaders,
        query: resolved.httpQuery,
        secrets: resolved.secrets,
        signal: options.signal,
      });
    } else if (resolved.mappedAgent !== undefined) {
      invocation = await invokeMappedHttpAgent(resolved.mappedAgent, request, {
        headers: resolved.httpHeaders,
        query: resolved.httpQuery,
        secrets: resolved.secrets,
        signal: options.signal,
      });
    } else if (resolved.target !== undefined) {
      invocation = await invokeAgent(resolved.target, request, {
        env: resolved.env,
        httpHeaders: resolved.httpHeaders,
        outputCapBytes: options.agent.limits?.response_bytes ?? DEFAULT_OUTPUT_CAP_BYTES,
        retries: options.agent.retry?.retries ?? 0,
        signal: options.signal,
        timeoutMs: options.agent.timeouts?.attempt_ms ?? DEFAULT_TIMEOUT_MS,
      });
    } else {
      throw new Error('Resolved agent omitted its invocation target.');
    }
  } catch (error: unknown) {
    if (
      !(error instanceof AgentInvocationError) ||
      (resolved.backgroundAgent === undefined && resolved.jsonlBridgeAgent === undefined)
    ) {
      throw error;
    }
    const diagnostics =
      'diagnostics' in error && error.diagnostics !== null && typeof error.diagnostics === 'object'
        ? (error.diagnostics as InvocationResult['diagnostics'])
        : {};
    const attempt = {
      status: 'invocation_error' as const,
      error,
      diagnostics,
      durationMs: performance.now() - managedStartupStarted,
      warnings: [],
    };
    invocation = { ...attempt, attempts: [attempt] };
  }
  if (invocation.status === 'invocation_error') {
    const code = invocation.error.code === 'cancelled' ? 'cancelled' : 'invocation_failed';
    await options.onExecution?.({
      attempts: storedAttempts(invocation.attempts, resolved.secrets),
      caseId: request.case_id,
      diagnostics: redactStored(invocation.diagnostics, resolved.secrets),
      durationMs: invocation.durationMs,
      errorCode: invocation.error.code,
      errorMessage: redactString(invocation.error.message, resolved.secrets),
      expectedMetrics: [],
      outcome:
        invocation.error.code === 'cancelled'
          ? 'cancelled'
          : invocation.error.code === 'timeout'
            ? 'timeout'
            : 'invocation_error',
      request: redactStored(request, resolved.secrets),
      startedAt,
      suiteName: `agent:${options.agent.id}`,
      warnings: redactStored(invocation.warnings, resolved.secrets),
    });
    throw new AttestCliError(
      code,
      `Agent connection test failed: ${redactString(invocation.error.message, resolved.secrets)}`,
      {
        hint:
          code === 'cancelled'
            ? 'Retry when cancellation is no longer required.'
            : 'Repair the agent mapping or transport and retry `attest agent test`.',
        details: redactProbeValue(
          {
            attempt_count: invocation.attempts.length,
            attempts: invocationAttempts(invocation.attempts),
            diagnostics: invocation.diagnostics,
            invocation_code: invocation.error.code,
            raw_excerpt: invocation.rawExcerpt,
          },
          resolved.secrets,
        ),
      },
    );
  }
  if (invocation.report === undefined || !invocation.report.ok) {
    throw new AttestCliError('internal_error', 'The adapter omitted its parse report.');
  }

  await options.onExecution?.({
    attempts: storedAttempts(invocation.attempts, resolved.secrets),
    caseId: request.case_id,
    diagnostics: redactStored(invocation.diagnostics, resolved.secrets),
    durationMs: invocation.durationMs,
    expectedMetrics: [],
    outcome: 'completed',
    request: redactStored(request, resolved.secrets),
    response: redactProbeValue(invocation.report.value, resolved.secrets),
    startedAt,
    suiteName: `agent:${options.agent.id}`,
    trace:
      invocation.report.value.trace === undefined
        ? undefined
        : redactStored(invocation.report.value.trace, resolved.secrets),
    warnings: redactStored(invocation.warnings, resolved.secrets),
  });

  const result = redactProbeValue(
    {
      agent_id: options.agent.id,
      attempt_count: invocation.attempts.length,
      attempts: invocationAttempts(invocation.attempts),
      response: invocation.report.value,
      transport: options.agent.transport.kind,
      warnings: invocation.report.warnings,
    },
    resolved.secrets,
  );
  options.onProgress?.(`Agent ${options.agent.id} completed.`);
  return result;
};

export {
  CONNECTION_TEST_RUN_ID,
  REDACTED,
  assertSupportedProbePolicy,
  createBaseEnvironment,
  readSecretReference,
  redactProbeValue,
  resolveNativeAgent,
  testNativeAgentConnection,
  type NativeAgentTestOptions,
  type ResolvedNativeAgent,
};
