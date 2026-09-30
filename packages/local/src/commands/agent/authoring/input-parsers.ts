import { vercelSandboxSchema, type JsonValue, type VercelSandbox } from '@attest/contracts';

import { LocalError } from '../../../errors/index.js';
import { schemaIssueDiagnostics } from '../../../internal/schema-issue-diagnostics.js';
import { parseJsonText } from '../../../internal/source-text.js';

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
    throw new LocalError('cli_usage', 'The native command contains an unclosed quote.', {
      path: '--native-command',
      hint: 'Close the quote or use `--argv-json` for an unambiguous argv array.',
    });
  }
  if (tokenStarted) argv.push(token);
  if (argv.length === 0) {
    throw new LocalError('cli_missing_input', 'The native command argv cannot be empty.', {
      path: '--native-command',
      hint: 'Pass a command string or a non-empty `--argv-json` array.',
    });
  }
  return argv;
};

/** Parses an unambiguous JSON argv array. */
const parseArgvJson = (value: string): string[] => {
  const parsed = parseJsonText(value, {
    path: '--argv-json',
    hint: 'Pass a JSON array of strings.',
  });
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((entry) => typeof entry !== 'string')
  ) {
    throw new LocalError('cli_usage', '`--argv-json` must be a non-empty string array.', {
      path: '--argv-json',
      hint: 'Example: `--argv-json \'["node","./agent.mjs"]\'`.',
    });
  }
  return parsed as string[];
};

/** Parses and validates one Vercel sandbox definition. */
const parseSandboxJson = (value: string): VercelSandbox => {
  const parsed = parseJsonText(value, {
    path: '--sandbox-json',
    hint: 'Pass one Vercel sandbox JSON object.',
  });
  const sandbox = vercelSandboxSchema.safeParse(parsed);
  if (!sandbox.success) {
    throw new LocalError('cli_usage', '`--sandbox-json` does not match the sandbox schema.', {
      path: '--sandbox-json',
      hint: 'Pass kind, files, and optional image, artifacts, or artifact_directory fields.',
      details: { diagnostics: schemaIssueDiagnostics(sandbox.error.issues) },
    });
  }
  return sandbox.data;
};

/** Parses a positive duration expressed as milliseconds, seconds, or minutes. */
const parseDuration = (value: string, path = '--timeout'): number => {
  const match = /^(\d+)(ms|s|m)$/u.exec(value);
  const amount = match?.[1] === undefined ? 0 : Number(match[1]);
  const unit = match?.[2];
  const multiplier = unit === 'm' ? 60_000 : unit === 's' ? 1_000 : 1;
  const milliseconds = amount * multiplier;
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new LocalError('cli_usage', 'Duration must be a positive value.', {
      path,
      hint: 'Use an integer followed by ms, s, or m, such as `60s`.',
    });
  }
  return milliseconds;
};

/** Parses repeatable JSON-valued command options. */
const parseJsonValues = (values: readonly string[], path: string): JsonValue[] =>
  values.map((value) =>
    parseJsonText(value, {
      path,
      hint: 'Quote strings as JSON, for example `--terminal-value \'"done"\'`.',
    }),
  );

/** Parses one WebSocket text-JSON request template. */
const parseRequestTemplate = (value: string): Record<string, JsonValue> => {
  const parsed = parseJsonText(value, {
    path: '--request-template',
    hint: 'Pass one JSON object containing exactly one `{{request_id}}` value.',
  });
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LocalError('cli_usage', '`--request-template` must be a JSON object.', {
      path: '--request-template',
      hint: 'Example: `{"request_id":"{{request_id}}","request":"{{request}}"}`.',
    });
  }
  return parsed;
};

/** Parses one background-process TCP readiness target. */
const parseTcpReadiness = (value: string): { host: string; port: number } => {
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/u.exec(value);
  const port = Number(match?.[2]);
  if (match?.[1] === undefined || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new LocalError('cli_usage', '--readiness-tcp must be HOST:PORT.', {
      path: '--readiness-tcp',
      hint: 'Example: `--readiness-tcp 127.0.0.1:8787`.',
    });
  }
  return { host: match[1].replace(/^\[|\]$/gu, ''), port };
};

export {
  parseArgvJson,
  parseDuration,
  parseJsonValues,
  parseRequestTemplate,
  parseSandboxJson,
  parseTcpReadiness,
  tokenizeCommand,
};
