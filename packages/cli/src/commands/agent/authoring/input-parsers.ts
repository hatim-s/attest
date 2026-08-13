import type { JsonValue, SecretReference } from '@attest/contracts';

import { AttestCliError } from '../../../errors/index.js';

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

/** Parses an unambiguous JSON argv array. */
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

/** Parses a positive duration expressed as milliseconds, seconds, or minutes. */
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

/** Parses repeatable JSON-valued command options. */
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

/** Parses one WebSocket text-JSON request template. */
const parseRequestTemplate = (value: string): Record<string, JsonValue> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new AttestCliError('cli_usage', '`--request-template` is not valid JSON.', {
      path: '--request-template',
      hint: 'Pass one JSON object containing exactly one `{{request_id}}` value.',
      cause: error,
    });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AttestCliError('cli_usage', '`--request-template` must be a JSON object.', {
      path: '--request-template',
      hint: 'Example: `{"request_id":"{{request_id}}","request":"{{request}}"}`.',
    });
  }
  return parsed as Record<string, JsonValue>;
};

/** Parses one background-process TCP readiness target. */
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

/** Parses target-to-environment secret bindings without reading secret values. */
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

export {
  parseArgvJson,
  parseDuration,
  parseJsonValues,
  parseRequestTemplate,
  parseSecretBindings,
  parseTcpReadiness,
  tokenizeCommand,
};
