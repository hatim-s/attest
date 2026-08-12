import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, resolve } from 'node:path';

import type { AgentResource, SecretReference } from '@attest/contracts';
import type { HttpAgentResource, StreamAgentResource, WebSocketAgentResource } from '@attest/core';

import { AttestCliError } from '../../../errors/index.js';
import { isProjectPath } from '../../../project/project-path.js';
import type { ResolvedNativeAgent } from './types.js';

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
  if (!isProjectPath(projectRoot, candidate)) {
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
      !isProjectPath(projectRoot, resolvedPath) ||
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
    if (!isProjectPath(projectRoot, resolved)) throw new Error('cwd escapes project');
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
        env: resolvedEnvironment.env,
        kind: 'direct',
        secrets: resolvedEnvironment.secrets,
        target: { type: 'cli', command: argv },
      };
    }
    if (transport.kind === 'jsonl_bridge') {
      return {
        agent: {
          ...agent,
          transport: { ...transport, argv },
        },
        cwd,
        env: resolvedEnvironment.env,
        kind: 'jsonl_bridge',
        secrets: resolvedEnvironment.secrets,
      };
    }
    const invoke = await resolveHttpSecrets([transport.invoke], projectRoot, observer);
    const shutdown =
      transport.shutdown === undefined
        ? { headers: {}, query: {}, secrets: [] }
        : await resolveHttpSecrets([transport.shutdown], projectRoot, observer);
    return {
      agent: {
        ...agent,
        transport: { ...transport, start_argv: argv },
      },
      cwd,
      env: resolvedEnvironment.env,
      invokeHeaders: invoke.headers,
      invokeQuery: invoke.query,
      kind: 'background',
      secrets: [...resolvedEnvironment.secrets, ...invoke.secrets, ...shutdown.secrets],
      shutdownHeaders: shutdown.headers,
      shutdownQuery: shutdown.query,
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
      return {
        headers,
        kind: 'direct',
        secrets,
        target: { type: 'http', url: request.url },
      };
    }
    if (transport.kind === 'stream') {
      return {
        agent: agent as StreamAgentResource,
        headers,
        kind: 'stream',
        query,
        secrets,
      };
    }
    return {
      agent: agent as HttpAgentResource,
      headers,
      kind: 'mapped_http',
      query,
      secrets,
    };
  }

  if (agent.transport.kind === 'websocket') {
    const resolved = await resolveHttpSecrets(
      [{ headers: agent.transport.headers }],
      projectRoot,
      observer,
    );
    for (const [name, value] of Object.entries(resolved.headers)) {
      if (agent.redaction?.headers?.some((header) => header.toLowerCase() === name.toLowerCase())) {
        resolved.secrets.push(value);
      }
    }
    return {
      agent: agent as WebSocketAgentResource,
      headers: resolved.headers,
      kind: 'websocket',
      secrets: [...new Set(resolved.secrets)],
    };
  }

  throw new AttestCliError(
    'project_invalid',
    `Agent ${agent.id} uses a transport that belongs to a later CLI item.`,
    {
      path: `/agents/${agent.id}/transport/kind`,
      hint: 'supports native_cli, background_cli, jsonl_bridge, HTTP, polling, and stream.',
    },
  );
};

/** Rejects authored policies that the selected bounded adapter cannot enforce. */

export { createBaseEnvironment, readSecretReference, resolveNativeAgent };
