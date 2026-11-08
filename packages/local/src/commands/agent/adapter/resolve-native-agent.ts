import {
  createBaseEnvironment,
  resolveProcessEnvironment,
  resolveHttpSecrets,
} from './metric-secrets.js';
import * as Effect from 'effect/Effect';
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import type { AgentResource } from '@attest/contracts';

import { LocalError } from '../../../errors/index.js';
import { isProjectPath } from '../../../project/project-path.js';
import type { ResolvedNativeAgent } from './types.js';

/** Resolves an authored cwd through realpath and rejects symlink escapes from the project. */
const resolveProcessCwd = (projectRoot: string, cwd = '.') =>
  Effect.tryPromise({
    try: async () => {
      const resolved = await realpath(resolve(projectRoot, cwd));

      if (!isProjectPath(projectRoot, resolved)) throw new Error('cwd escapes project');

      return resolved;
    },
    catch: (cause) =>
      new LocalError('invocation_failed', 'The managed process cwd is unavailable.', {
        path: cwd,
        hint: 'Use an existing project-contained directory without symlink traversal.',
        cause,
      }),
  });

/** Resolves only explicit relative argv paths against the authored cwd; no shell parsing occurs. */
const resolveProcessArgv = (argv: readonly string[], cwd: string): string[] =>
  argv.map((argument) =>
    isAbsolute(argument) || !(argument === '.' || argument === '..' || /^\.\.?\//u.test(argument))
      ? argument
      : resolve(cwd, argument),
  );

/** Adds literal header and query values the agent marks for redaction to its secret list. */
const addRedactedRequestValues = (
  agent: AgentResource,
  resolved: Effect.Success<ReturnType<typeof resolveHttpSecrets>>,
): void => {
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
const redactedArgvValues = Effect.fn('redactedArgvValues')(function* (
  agent: AgentResource,
  argv: readonly string[],
) {
  const values: string[] = [];

  for (const position of agent.redaction?.argv_positions ?? []) {
    const value = argv[position];

    if (value === undefined) {
      // Authored argv positions have already been validated before runtime resolution.
      return yield* Effect.die(
        new LocalError('project_invalid', 'An argv redaction position is out of range.', {
          path: `/agents/${agent.id}/redaction/argv_positions`,
        }),
      );
    }

    values.push(value);
  }

  return values;
});

type ProcessTransport = Extract<
  AgentResource['transport'],
  { kind: 'background_cli' | 'jsonl_bridge' | 'native_cli' }
>;

/** Resolves a process-based transport: environment, cwd, argv, and redacted argv values. */
const resolveProcessAgent = Effect.fn('resolveProcessAgent')(function* (
  agent: AgentResource,
  transport: ProcessTransport,
  projectRoot: string,
): Effect.fn.Return<ResolvedNativeAgent, Error> {
  const { env, variables, secrets } = yield* resolveProcessEnvironment(transport.env, projectRoot);

  if (transport.kind === 'native_cli' && transport.sandbox !== undefined) {
    return {
      argv: [transport.argv[0]!, ...transport.argv.slice(1)],
      cwd: transport.cwd,
      env: variables,
      kind: 'vercel_sandbox',
      sandbox: transport.sandbox,
      secrets: [...secrets, ...(yield* redactedArgvValues(agent, transport.argv))],
    };
  }

  const cwd = yield* resolveProcessCwd(projectRoot, transport.cwd);
  const authoredArgv = transport.kind === 'background_cli' ? transport.start_argv : transport.argv;
  const argv = resolveProcessArgv(authoredArgv, cwd);
  const processSecrets = [...secrets, ...(yield* redactedArgvValues(agent, argv))];

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

  const invoke = yield* resolveHttpSecrets(transport.invoke, projectRoot);

  const shutdown =
    transport.shutdown === undefined
      ? { headers: {}, query: {}, secrets: [] }
      : yield* resolveHttpSecrets(transport.shutdown, projectRoot);

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
});

/** Resolves runtime-only secret references into an ephemeral native transport target. */
const resolveNativeAgent = Effect.fn('resolveNativeAgent')(function* (
  agent: AgentResource,
  projectRoot: string,
): Effect.fn.Return<ResolvedNativeAgent, Error> {
  const transport = agent.transport;

  switch (transport.kind) {
    case 'native_cli':
    case 'background_cli':
    case 'jsonl_bridge':
      return yield* resolveProcessAgent(agent, transport, projectRoot);
    case 'websocket': {
      const resolved = yield* resolveHttpSecrets({ headers: transport.headers }, projectRoot);

      addRedactedRequestValues(agent, resolved);

      return {
        agent: { ...agent, transport },
        headers: resolved.headers,
        kind: 'websocket',
        secrets: [...new Set(resolved.secrets)],
      };
    }

    case 'stream': {
      const resolved = yield* resolveHttpSecrets(transport.request, projectRoot);

      addRedactedRequestValues(agent, resolved);

      return { agent: { ...agent, transport }, kind: 'stream', ...resolved };
    }

    case 'http':
    case 'polling': {
      const request = transport.kind === 'polling' ? transport.submit : transport.request;

      const resolved = yield* resolveHttpSecrets(request, projectRoot);

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

    case 'callback': {
      const resolveTemplate = Effect.fn('resolveTemplate')(function* (
        request: typeof transport.trigger,
      ) {
        const resolved = yield* resolveHttpSecrets(request, projectRoot);

        addRedactedRequestValues(agent, resolved);

        return resolved;
      });

      const trigger = yield* resolveTemplate(transport.trigger);

      const artifactFetch =
        transport.artifact_fetch === undefined
          ? undefined
          : yield* resolveTemplate(transport.artifact_fetch);

      const traceFetch =
        transport.trace_fetch === undefined
          ? undefined
          : yield* resolveTemplate(transport.trace_fetch);

      return {
        agent: { ...agent, transport },
        artifactFetch,
        kind: 'callback',
        secrets: [
          ...new Set([
            ...trigger.secrets,
            ...(artifactFetch?.secrets ?? []),
            ...(traceFetch?.secrets ?? []),
          ]),
        ],
        traceFetch,
        trigger,
      };
    }

    default:
      return transport satisfies never;
  }
});

export { createBaseEnvironment, resolveHttpSecrets, resolveNativeAgent, resolveProcessEnvironment };
