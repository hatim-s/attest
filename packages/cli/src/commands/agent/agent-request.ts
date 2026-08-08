import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

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
import type { JsonValue } from '../../project/canonical-project.js';

type ReadInput = () => Promise<string>;

type AgentAddFields = {
  agentId: string;
  argvJson?: string;
  env?: readonly string[];
  headerEnv?: readonly string[];
  name?: string;
  nativeCommand?: string;
  nativeHttp?: string;
  timeout?: string;
  trace?: boolean;
};

const requestDiagnostics = (
  issues: readonly { message: string; path: PropertyKey[] }[],
): JsonValue => issues.map(({ message, path }) => ({ message, path: `/${path.join('/')}` }));

/** Reads one JSON document while ensuring parse failures never echo sensitive source text. */
const readJsonDocument = async (
  source: string,
  workingDirectory: string,
  readStdin: ReadInput,
  path: string,
): Promise<unknown> => {
  let text: string;
  try {
    text =
      source === '-'
        ? await readStdin()
        : await readFile(resolve(workingDirectory, source), 'utf8');
  } catch (error: unknown) {
    throw new AttestCliError('cli_usage', `Could not read JSON from ${source}.`, {
      path,
      hint: 'Pass a readable JSON file or `-` for stdin.',
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

const parseDuration = (value: string): number => {
  const match = /^(\d+)(ms|s|m)$/u.exec(value);
  const amount = match?.[1] === undefined ? 0 : Number(match[1]);
  const unit = match?.[2];
  const multiplier = unit === 'm' ? 60_000 : unit === 's' ? 1_000 : 1;
  const milliseconds = amount * multiplier;
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new AttestCliError('cli_usage', 'Timeout must be a positive duration.', {
      path: '--timeout',
      hint: 'Use an integer followed by ms, s, or m, such as `60s`.',
    });
  }
  return milliseconds;
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

/** Rejects authored literal credentials and every transport deferred to later CLI items. */
const assertSafeNativeAgentResource = (agent: AgentResource): void => {
  const transport = agent.transport;
  if (transport.kind === 'native_cli') {
    const sensitivePosition = transport.argv.findIndex((argument) => SENSITIVE_NAME.test(argument));
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
    return;
  }
  if (transport.kind !== 'http') {
    throw new AttestCliError('project_invalid', 'This transport belongs to a later CLI item.', {
      path: '/agent/transport/kind',
      hint: 'CLI2.6 accepts only native_cli and native-envelope http resources.',
    });
  }
  let url: URL;
  try {
    url = new URL(transport.request.url);
  } catch {
    throw new AttestCliError('project_invalid', 'Native HTTP URL is invalid.', {
      path: '/agent/transport/request/url',
    });
  }
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    [...url.searchParams.keys()].some((key) => SENSITIVE_NAME.test(key))
  ) {
    throw new AttestCliError('project_invalid', 'Native HTTP URL contains literal credentials.', {
      path: '/agent/transport/request/url',
      hint: 'Move authentication to an environment-backed header reference.',
    });
  }
  for (const [name, value] of Object.entries(transport.request.headers ?? {})) {
    if (SENSITIVE_NAME.test(name) && typeof value === 'string') {
      throw new AttestCliError(
        'project_invalid',
        'Sensitive HTTP headers must use secret references.',
        {
          path: `/agent/transport/request/headers/${name}`,
          hint: 'Use `{ "from_env": "NAME" }` instead of a literal value.',
        },
      );
    }
  }
};

/** Normalizes non-interactive or wizard-populated add fields into one v2 resource. */
const createAgentResource = (fields: AgentAddFields): AgentResource => {
  const selected = [fields.argvJson, fields.nativeCommand, fields.nativeHttp].filter(
    (value) => value !== undefined,
  );
  if (selected.length !== 1) {
    throw new AttestCliError(
      selected.length === 0 ? 'cli_missing_input' : 'cli_usage',
      'Select exactly one native agent transport.',
      {
        path: '--argv-json',
        hint: 'Pass one of `--argv-json`, `--native-command`, or `--native-http`.',
      },
    );
  }
  const timeout = fields.timeout === undefined ? undefined : parseDuration(fields.timeout);
  const name = fields.name?.trim() || fields.agentId;
  const transport =
    fields.nativeHttp === undefined
      ? {
          kind: 'native_cli' as const,
          lifecycle: 'per_case' as const,
          argv:
            fields.argvJson === undefined
              ? tokenizeCommand(fields.nativeCommand ?? '')
              : parseArgvJson(fields.argvJson),
          ...(fields.env === undefined || fields.env.length === 0
            ? {}
            : { env: parseSecretBindings(fields.env, '--env') }),
        }
      : {
          kind: 'http' as const,
          lifecycle: 'external' as const,
          request: {
            url: fields.nativeHttp,
            method: 'POST' as const,
            ...(fields.headerEnv === undefined || fields.headerEnv.length === 0
              ? {}
              : { headers: parseSecretBindings(fields.headerEnv, '--header-env') }),
          },
          extraction: { result_pointer: '' },
        };
  const parsed = agentResourceSchema.safeParse({
    schema: AGENT_RESOURCE_SCHEMA_VERSION,
    id: fields.agentId,
    name,
    transport,
    ...(timeout === undefined ? {} : { timeouts: { attempt_ms: timeout } }),
    ...(fields.trace === undefined ? {} : { capabilities: { trace: fields.trace } }),
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
  const value = await readJsonDocument(source, workingDirectory, readStdin, 'source');
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

export {
  assertSafeNativeAgentResource,
  createAgentResource,
  parseArgvJson,
  parseDuration,
  readAgentCommandRequest,
  readImportedAgentResource,
  tokenizeCommand,
  type AgentAddFields,
  type ReadInput,
};
