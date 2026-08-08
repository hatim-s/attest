import { lstat, readFile, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, relative, resolve, sep } from 'node:path';

import {
  AGENT_PROTOCOL,
  type AgentRequest,
  type AgentResource,
  type AgentTarget,
  type JsonValue,
  type SecretReference,
} from '@attest/contracts';
import { invokeAgent } from '@attest/core';

import { AttestCliError } from '../../errors.js';

const CONNECTION_TEST_RUN_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const DEFAULT_OUTPUT_CAP_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const REDACTED = '[REDACTED]';

type NativeAgentTestOptions = {
  agent: AgentResource;
  input: JsonValue;
  projectRoot: string;
  signal?: AbortSignal;
};

type ResolvedNativeAgent = {
  env?: Record<string, string>;
  httpHeaders?: Record<string, string>;
  secrets: string[];
  target: AgentTarget;
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
  let resolvedPath: string;
  try {
    resolvedPath = await realpath(candidate);
    const metadata = await lstat(resolvedPath);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
      throw new Error('secret file must be a private regular file');
    }
  } catch (error: unknown) {
    throw new AttestCliError('invocation_failed', 'A referenced secret file is unavailable.', {
      path: reference.from_file,
      hint: 'Use a project-contained regular file with group/world permissions removed.',
      cause: error,
    });
  }
  if (!isContainedPath(projectRoot, resolvedPath)) {
    throw new AttestCliError('invocation_failed', 'A secret file resolves outside the project.', {
      path: reference.from_file,
      hint: 'Use a project-contained secret file or an environment reference.',
    });
  }
  return readFile(resolvedPath, 'utf8');
};

/** Builds the minimum safe inherited environment used by the hardened native CLI invoker. */
const createBaseEnvironment = (): Record<string, string> => ({
  PATH: (process.env.PATH ?? '')
    .split(delimiter)
    .filter((entry) => isAbsolute(entry))
    .join(delimiter),
  LC_ALL: 'C',
});

/** Resolves runtime-only secret references into an ephemeral native transport target. */
const resolveNativeAgent = async (
  agent: AgentResource,
  projectRoot: string,
): Promise<ResolvedNativeAgent> => {
  if (agent.transport.kind === 'native_cli') {
    const transport = agent.transport;
    const env = createBaseEnvironment();
    const secrets: string[] = [];
    for (const [name, reference] of Object.entries(transport.env ?? {})) {
      const value = await readSecretReference(reference, projectRoot);
      env[name] = value;
      secrets.push(value);
    }
    const argv = transport.argv.map((argument) =>
      isAbsolute(argument) || !(argument === '.' || argument === '..' || /^\.\.?\//u.test(argument))
        ? argument
        : resolve(projectRoot, transport.cwd ?? '.', argument),
    );
    return { env, secrets, target: { type: 'cli', command: argv } };
  }

  if (agent.transport.kind === 'http') {
    const { extraction, request } = agent.transport;
    if (
      request.method !== 'POST' ||
      request.body !== undefined ||
      request.query !== undefined ||
      extraction.result_pointer !== '' ||
      extraction.error_pointer !== undefined ||
      extraction.trace_pointer !== undefined ||
      extraction.remote_job_id_pointer !== undefined
    ) {
      throw new AttestCliError(
        'project_invalid',
        'CLI2.6 supports only native-envelope HTTP agent resources.',
        {
          path: `/agents/${agent.id}/transport`,
          hint: 'Use POST with the native request body and an empty result pointer.',
        },
      );
    }
    const headers: Record<string, string> = {};
    const secrets: string[] = [];
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      if (typeof value === 'string') {
        headers[name] = value;
      } else {
        const resolved = await readSecretReference(value, projectRoot);
        headers[name] = resolved;
        secrets.push(resolved);
      }
    }
    return { httpHeaders: headers, secrets, target: { type: 'http', url: request.url } };
  }

  throw new AttestCliError(
    'project_invalid',
    `Agent ${agent.id} uses a transport that belongs to a later CLI item.`,
    {
      path: `/agents/${agent.id}/transport/kind`,
      hint: 'Use native_cli or native-envelope http for CLI2.6 connection tests.',
    },
  );
};

const redactString = (value: string, secrets: readonly string[]): string =>
  secrets
    .filter((secret) => secret.length > 0)
    .reduce((redacted, secret) => redacted.replaceAll(secret, REDACTED), value);

/** Recursively removes runtime secret values and sensitive named fields from probe evidence. */
const redactProbeValue = (value: unknown, secrets: readonly string[]): JsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => redactProbeValue(entry, secrets));
  if (typeof value !== 'object') return null;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      /authorization|cookie|password|secret|token|api[-_]?key/iu.test(key)
        ? REDACTED
        : redactProbeValue(entry, secrets),
    ]),
  );
};

/** Runs one native contract probe and returns only bounded, redacted, deterministic evidence. */
const testNativeAgentConnection = async (options: NativeAgentTestOptions): Promise<JsonValue> => {
  const resolved = await resolveNativeAgent(options.agent, options.projectRoot);
  const request: AgentRequest = {
    protocol: AGENT_PROTOCOL,
    run_id: CONNECTION_TEST_RUN_ID,
    case_id: 'connection-test',
    input: options.input,
  };
  const invocation = await invokeAgent(resolved.target, request, {
    env: resolved.env,
    httpHeaders: resolved.httpHeaders,
    outputCapBytes: options.agent.limits?.response_bytes ?? DEFAULT_OUTPUT_CAP_BYTES,
    retries: options.agent.retry?.retries ?? 0,
    signal: options.signal,
    timeoutMs: options.agent.timeouts?.attempt_ms ?? DEFAULT_TIMEOUT_MS,
  });
  if (invocation.status === 'invocation_error') {
    const code = invocation.error.code === 'cancelled' ? 'cancelled' : 'invocation_failed';
    throw new AttestCliError(code, `Agent connection test failed: ${invocation.error.message}`, {
      hint:
        code === 'cancelled'
          ? 'Retry when cancellation is no longer required.'
          : 'Repair the native agent contract and retry `attest agent test`.',
      details: redactProbeValue(
        {
          attempt_count: invocation.attempts.length,
          diagnostics: invocation.diagnostics,
          invocation_code: invocation.error.code,
          raw_excerpt: invocation.rawExcerpt,
        },
        resolved.secrets,
      ),
    });
  }
  if (invocation.report === undefined || !invocation.report.ok) {
    throw new AttestCliError('internal_error', 'The native invoker omitted its parse report.');
  }

  return redactProbeValue(
    {
      agent_id: options.agent.id,
      attempt_count: invocation.attempts.length,
      response: invocation.report.value,
      transport: options.agent.transport.kind,
      warnings: invocation.report.warnings,
    },
    resolved.secrets,
  );
};

export {
  CONNECTION_TEST_RUN_ID,
  REDACTED,
  redactProbeValue,
  resolveNativeAgent,
  testNativeAgentConnection,
  type NativeAgentTestOptions,
  type ResolvedNativeAgent,
};
