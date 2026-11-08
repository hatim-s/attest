import {
  isJsonObject,
  parseWithSchema,
  tryOwned,
  vercelSandboxSchema,
  type JsonValue,
} from '@attest/contracts';

import * as Schema from 'effect/Schema';
import * as Effect from 'effect/Effect';

import { LocalError } from '../../../errors/index.js';
import { schemaIssueDiagnostics } from '../../../internal/schema-issue-diagnostics.js';
import { parseJsonText } from '../../../internal/source-text.js';
import { ShellWordsError, splitShellWords } from '../shell-words.js';

/** Tokenizes a convenience command string into argv without expansion or shell execution. */
const tokenizeCommand = Effect.fn('tokenizeCommand')(function* (value: string) {
  const argv = yield* tryOwned(
    ShellWordsError,
    () => splitShellWords(value, { rejectShellControl: false }),
    () =>
      new LocalError('cli_usage', 'The native command contains an unclosed quote.', {
        path: '--native-command',
        hint: 'Close the quote or use `--argv-json` for an unambiguous argv array.',
      }),
  );

  if (argv.length === 0) {
    return yield* new LocalError('cli_missing_input', 'The native command argv cannot be empty.', {
      path: '--native-command',
      hint: 'Pass a command string or a non-empty `--argv-json` array.',
    });
  }

  return argv;
});

/** Parses an unambiguous JSON argv array. */
const parseArgvJson = Effect.fn('parseArgvJson')(function* (value: string) {
  const parsed = yield* parseJsonText(value, {
    path: '--argv-json',
    hint: 'Pass a JSON array of strings.',
  });

  const argv = parseWithSchema(Schema.Array(Schema.String).check(Schema.isMinLength(1)), parsed);

  if (!argv.ok) {
    return yield* new LocalError('cli_usage', '`--argv-json` must be a non-empty string array.', {
      path: '--argv-json',
      hint: 'Pass a JSON array containing at least one string.',
    });
  }

  return argv.value;
});

/** Parses and validates one Vercel sandbox definition. */
const parseSandboxJson = Effect.fn('parseSandboxJson')(function* (value: string) {
  const parsed = yield* parseJsonText(value, {
    path: '--sandbox-json',
    hint: 'Pass one Vercel sandbox JSON object.',
  });

  const sandbox = parseWithSchema(vercelSandboxSchema, parsed);

  if (!sandbox.ok) {
    return yield* new LocalError(
      'cli_usage',
      '`--sandbox-json` does not match the sandbox schema.',
      {
        path: '--sandbox-json',
        hint: 'Pass kind, files, and optional image, artifacts, or artifact_directory fields.',
        details: { diagnostics: schemaIssueDiagnostics(sandbox.error.issues) },
      },
    );
  }

  return sandbox.value;
});

/** Parses a positive duration expressed as milliseconds, seconds, or minutes. */
const parseDuration = Effect.fn('parseDuration')(function* (
  value: string,
  path: string = '--timeout',
) {
  const match = /^(\d+)(ms|s|m)$/u.exec(value);
  const amount = match?.[1] === undefined ? 0 : Number(match[1]);
  const unit = match?.[2];
  const multiplier = unit === 'm' ? 60_000 : unit === 's' ? 1_000 : 1;
  const milliseconds = amount * multiplier;

  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    return yield* new LocalError('cli_usage', 'Duration must be a positive value.', {
      path,
      hint: 'Use an integer followed by ms, s, or m, such as `60s`.',
    });
  }

  return milliseconds;
});

/** Parses repeatable JSON-valued command options, failing on the first invalid value. */
const parseJsonValues = Effect.fn('parseJsonValues')(function* (
  values: readonly string[],
  path: string,
) {
  const parsed: JsonValue[] = [];

  for (const value of values) {
    parsed.push(
      yield* parseJsonText(value, {
        path,
        hint: 'Quote strings as JSON, for example `--terminal-value \'"done"\'`.',
      }),
    );
  }

  return parsed;
});

/** Parses one WebSocket text-JSON request template. */
// BOUNDARY: CLI JSON template text is decoded and rejected unless it is an object containing the required request id placeholder.
const parseRequestTemplate = Effect.fn('parseRequestTemplate')(function* (value: string) {
  const parsed = yield* parseJsonText(value, {
    path: '--request-template',
    hint: 'Pass one JSON object containing exactly one `{{request_id}}` value.',
  });

  if (!isJsonObject(parsed)) {
    return yield* new LocalError('cli_usage', '`--request-template` must be a JSON object.', {
      path: '--request-template',
      hint: 'Example: `{"request_id":"{{request_id}}","request":"{{request}}"}`.',
    });
  }

  return parsed;
});

/** Parses one background-process TCP readiness target. */
const parseTcpReadiness = Effect.fn('parseTcpReadiness')(function* (value: string) {
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/u.exec(value);
  const port = Number(match?.[2]);

  if (match?.[1] === undefined || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return yield* new LocalError('cli_usage', '--readiness-tcp must be HOST:PORT.', {
      path: '--readiness-tcp',
      hint: 'Example: `--readiness-tcp 127.0.0.1:8787`.',
    });
  }

  return { host: match[1].replace(/^\[|\]$/gu, ''), port };
});

export {
  parseArgvJson,
  parseDuration,
  parseJsonValues,
  parseRequestTemplate,
  parseSandboxJson,
  parseTcpReadiness,
  tokenizeCommand,
};
