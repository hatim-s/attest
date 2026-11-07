import {
  createBaseEnvironment,
  resolveProcessEnvironment,
  resolveHttpSecrets,
} from './metric-secrets.js';
import { valueFromExit } from '../../../internal/effect-exit.js';
import * as Effect from 'effect/Effect';
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import type { AgentResource } from '@attest/contracts';

import { LocalError } from '../../../errors/index.js';
import { isProjectPath } from '../../../project/project-path.js';
import type { ResolvedNativeAgent } from './types.js';

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
  const { env, variables, secrets } =
    await // EFFECT-BRIDGE(S7b): native secret resolution from the agent configuration parent.
    Effect.runPromiseExit(resolveProcessEnvironment(transport.env, projectRoot)).then(
      valueFromExit,
    );

  if (transport.kind === 'native_cli' && transport.sandbox !== undefined) {
    return {
      argv: [transport.argv[0]!, ...transport.argv.slice(1)],
      cwd: transport.cwd,
      env: variables,
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

  const invoke =
    await // EFFECT-BRIDGE(S7b): native secret resolution from the agent configuration parent.
    Effect.runPromiseExit(resolveHttpSecrets(transport.invoke, projectRoot)).then(valueFromExit);

  const shutdown =
    transport.shutdown === undefined
      ? { headers: {}, query: {}, secrets: [] }
      : await // EFFECT-BRIDGE(S7b): native secret resolution from the agent configuration parent.
        Effect.runPromiseExit(resolveHttpSecrets(transport.shutdown, projectRoot)).then(
          valueFromExit,
        );

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
      const resolved =
        await // EFFECT-BRIDGE(S7b): native secret resolution from the agent configuration parent.
        Effect.runPromiseExit(resolveHttpSecrets({ headers: transport.headers }, projectRoot)).then(
          valueFromExit,
        );

      addRedactedRequestValues(agent, resolved);

      return {
        agent: { ...agent, transport },
        headers: resolved.headers,
        kind: 'websocket',
        secrets: [...new Set(resolved.secrets)],
      };
    }

    case 'stream': {
      const resolved =
        await // EFFECT-BRIDGE(S7b): native secret resolution from the agent configuration parent.
        Effect.runPromiseExit(resolveHttpSecrets(transport.request, projectRoot)).then(
          valueFromExit,
        );

      addRedactedRequestValues(agent, resolved);

      return { agent: { ...agent, transport }, kind: 'stream', ...resolved };
    }

    case 'http':
    case 'polling': {
      const request = transport.kind === 'polling' ? transport.submit : transport.request;

      const resolved =
        await // EFFECT-BRIDGE(S7b): native secret resolution from the agent configuration parent.
        Effect.runPromiseExit(resolveHttpSecrets(request, projectRoot)).then(valueFromExit);

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
      const resolveTemplate = async (request: typeof transport.trigger) => {
        const resolved =
          await // EFFECT-BRIDGE(S7b): native secret resolution from the agent configuration parent.
          Effect.runPromiseExit(resolveHttpSecrets(request, projectRoot)).then(valueFromExit);

        addRedactedRequestValues(agent, resolved);

        return resolved;
      };

      const trigger = await resolveTemplate(transport.trigger);

      const artifactFetch =
        transport.artifact_fetch === undefined
          ? undefined
          : await resolveTemplate(transport.artifact_fetch);

      const traceFetch =
        transport.trace_fetch === undefined
          ? undefined
          : await resolveTemplate(transport.trace_fetch);

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
};

export { createBaseEnvironment, resolveHttpSecrets, resolveNativeAgent, resolveProcessEnvironment };
