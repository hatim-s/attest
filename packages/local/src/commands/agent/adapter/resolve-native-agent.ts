import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, resolve } from 'node:path';

import type { AgentResource, SecretReference } from '@attest/contracts';

import { LocalError } from '../../../errors/index.js';
import { openAnchored, type AnchoredEntry } from '../../../internal/open-anchored.js';
import { isProjectPath } from '../../../project/project-path.js';
import type { ResolvedNativeAgent } from './types.js';

/** Reads a secret reference at invocation time without returning its source path or value. */
const readSecretReference = async (
  reference: SecretReference,
  projectRoot: string,
): Promise<string> => {
  if ('from_env' in reference) {
    const value = process.env[reference.from_env];
    if (value === undefined) {
      throw new LocalError('invocation_failed', 'A referenced environment secret is missing.', {
        path: reference.from_env,
        hint: 'Set the referenced environment variable and retry the connection test.',
      });
    }
    return value;
  }

  const candidate = resolve(projectRoot, reference.from_file);
  if (!isProjectPath(projectRoot, candidate)) {
    throw new LocalError('invocation_failed', 'A secret file is outside the project.', {
      path: reference.from_file,
      hint: 'Use a project-contained secret file or an environment reference.',
    });
  }
  let entry: AnchoredEntry | undefined;
  try {
    entry = await openAnchored(candidate, { kind: 'file', root: projectRoot });
    if ((entry.identity.mode & 0o077n) !== 0n) {
      throw new Error('secret file must not be readable by group or others');
    }
    return await entry.handle.readFile('utf8');
  } catch (error: unknown) {
    throw new LocalError('invocation_failed', 'A referenced secret file is unavailable.', {
      path: reference.from_file,
      hint: 'Use a project-contained regular file with group/world permissions removed.',
      cause: error,
    });
  } finally {
    await entry?.handle.close().catch(() => undefined);
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
    if (!isProjectPath(projectRoot, resolved)) throw new Error('cwd escapes project');
    return resolved;
  } catch (error: unknown) {
    throw new LocalError('invocation_failed', 'The managed process cwd is unavailable.', {
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

/**
 * Builds a child process environment from the hardened base plus secret references read at
 * invocation time. Returns the secret values too so every evidence path can redact them.
 */
const resolveProcessEnvironment = async (
  references: Readonly<Record<string, SecretReference>> | undefined,
  projectRoot: string,
): Promise<{ env: Record<string, string>; secrets: string[] }> => {
  const env = createBaseEnvironment();
  const secrets: string[] = [];
  for (const [name, reference] of Object.entries(references ?? {})) {
    const value = await readSecretReference(reference, projectRoot);
    env[name] = value;
    secrets.push(value);
  }
  return { env, secrets };
};

type ResolvedRequestSecrets = {
  headers: Record<string, string>;
  query: Record<string, string>;
  secrets: string[];
};

/** Resolves one request template's secret references without changing the authored resource. */
const resolveHttpSecrets = async (
  request: {
    headers?: Record<string, string | SecretReference>;
    query?: Record<string, string | SecretReference>;
  },
  projectRoot: string,
): Promise<ResolvedRequestSecrets> => {
  const resolveValues = async (
    values: Record<string, string | SecretReference> | undefined,
    secrets: string[],
  ): Promise<Record<string, string>> => {
    const resolved: Record<string, string> = {};
    for (const [name, value] of Object.entries(values ?? {})) {
      if (typeof value === 'string') {
        resolved[name] = value;
        continue;
      }
      resolved[name] = await readSecretReference(value, projectRoot);
      secrets.push(resolved[name]);
    }
    return resolved;
  };
  const secrets: string[] = [];
  const headers = await resolveValues(request.headers, secrets);
  const query = await resolveValues(request.query, secrets);
  return { headers, query, secrets };
};

/** Adds literal header and query values the agent marks for redaction to its secret list. */
const addRedactedRequestValues = (agent: AgentResource, resolved: ResolvedRequestSecrets): void => {
  const redactedHeaders = new Set(agent.redaction?.headers?.map((name) => name.toLowerCase()));
  for (const [name, value] of Object.entries(resolved.headers)) {
    if (redactedHeaders.has(name.toLowerCase())) resolved.secrets.push(value);
  }
  for (const name of agent.redaction?.query ?? []) {
    const value = resolved.query[name];
    if (value !== undefined) resolved.secrets.push(value);
  }
};

/** Reads the argv values the agent marks for redaction, so evidence can hide them. */
const redactedArgvValues = (agent: AgentResource, argv: readonly string[]): string[] =>
  (agent.redaction?.argv_positions ?? []).map((position) => {
    const value = argv[position];
    if (value === undefined) {
      throw new LocalError('project_invalid', 'An argv redaction position is out of range.', {
        path: `/agents/${agent.id}/redaction/argv_positions`,
      });
    }
    return value;
  });

type ProcessTransport = Extract<
  AgentResource['transport'],
  { kind: 'background_cli' | 'jsonl_bridge' | 'native_cli' }
>;

/** Resolves a process-based transport: environment, cwd, argv, and redacted argv values. */
const resolveProcessAgent = async (
  agent: AgentResource,
  transport: ProcessTransport,
  projectRoot: string,
): Promise<ResolvedNativeAgent> => {
  const { env, secrets } = await resolveProcessEnvironment(transport.env, projectRoot);
  if (transport.kind === 'native_cli' && transport.sandbox !== undefined) {
    const sandboxEnvironment = Object.fromEntries(
      Object.keys(transport.env ?? {}).flatMap((name) => {
        const value = env[name];
        return value === undefined ? [] : [[name, value]];
      }),
    );
    return {
      argv: [transport.argv[0]!, ...transport.argv.slice(1)],
      ...(transport.cwd === undefined ? {} : { cwd: transport.cwd }),
      env: sandboxEnvironment,
      kind: 'vercel_sandbox',
      sandbox: transport.sandbox,
      secrets: [...secrets, ...redactedArgvValues(agent, transport.argv)],
    };
  }
  const cwd = await resolveProcessCwd(projectRoot, transport.cwd);
  const authoredArgv = transport.kind === 'background_cli' ? transport.start_argv : transport.argv;
  const argv = resolveProcessArgv(authoredArgv, cwd);
  const processSecrets = [...secrets, ...redactedArgvValues(agent, argv)];
  if (transport.kind === 'native_cli') {
    return {
      env,
      kind: 'direct',
      secrets: processSecrets,
      target: { type: 'cli', command: argv },
    };
  }
  if (transport.kind === 'jsonl_bridge') {
    return {
      agent: { ...agent, transport: { ...transport, argv } },
      cwd,
      env,
      kind: 'jsonl_bridge',
      secrets: processSecrets,
    };
  }
  const invoke = await resolveHttpSecrets(transport.invoke, projectRoot);
  const shutdown =
    transport.shutdown === undefined
      ? { headers: {}, query: {}, secrets: [] }
      : await resolveHttpSecrets(transport.shutdown, projectRoot);
  return {
    agent: { ...agent, transport: { ...transport, start_argv: argv } },
    cwd,
    env,
    invokeHeaders: invoke.headers,
    invokeQuery: invoke.query,
    kind: 'background',
    secrets: [...processSecrets, ...invoke.secrets, ...shutdown.secrets],
    shutdownHeaders: shutdown.headers,
    shutdownQuery: shutdown.query,
  };
};

/** Resolves runtime-only secret references into an ephemeral native transport target. */
const resolveNativeAgent = async (
  agent: AgentResource,
  projectRoot: string,
): Promise<ResolvedNativeAgent> => {
  const transport = agent.transport;
  switch (transport.kind) {
    case 'native_cli':
    case 'background_cli':
    case 'jsonl_bridge':
      return resolveProcessAgent(agent, transport, projectRoot);
    case 'websocket': {
      const resolved = await resolveHttpSecrets({ headers: transport.headers }, projectRoot);
      addRedactedRequestValues(agent, resolved);
      return {
        agent: { ...agent, transport },
        headers: resolved.headers,
        kind: 'websocket',
        secrets: [...new Set(resolved.secrets)],
      };
    }
    case 'stream': {
      const resolved = await resolveHttpSecrets(transport.request, projectRoot);
      addRedactedRequestValues(agent, resolved);
      return { agent: { ...agent, transport }, kind: 'stream', ...resolved };
    }
    case 'http':
    case 'polling': {
      const request = transport.kind === 'polling' ? transport.submit : transport.request;
      const resolved = await resolveHttpSecrets(request, projectRoot);
      addRedactedRequestValues(agent, resolved);
      if (transport.kind === 'http' && transport.response_mode === 'attest_envelope') {
        return {
          headers: resolved.headers,
          kind: 'direct',
          secrets: resolved.secrets,
          target: { type: 'http', url: request.url },
        };
      }
      return { agent: { ...agent, transport }, kind: 'mapped_http', ...resolved };
    }
    default:
      return transport satisfies never;
  }
};

export { createBaseEnvironment, resolveNativeAgent, resolveProcessEnvironment };
