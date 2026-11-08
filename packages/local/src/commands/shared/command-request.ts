import * as Effect from 'effect/Effect';
import {
  parseWithSchema,
  COMMAND_REQUEST_SCHEMA_ID,
  commandRequestSchema,
  type CommandRequest,
} from '@attest/contracts';

import { LocalError } from '../../errors/index.js';
import { schemaIssueDiagnostics } from '../../internal/schema-issue-diagnostics.js';
import { parseJsonText, readSourceText } from '../../internal/source-text.js';

type CommandRequestFor<TCommand extends CommandRequest['command']> = Extract<
  CommandRequest,
  { command: TCommand }
>;

type ReadCommandRequestOptions = {
  readStdin: () => Promise<string>;
  workingDirectory: string;
};

type ReadRequestDocumentOptions = ReadCommandRequestOptions & {
  /** Repair hint for a document that is not valid JSON. */
  hint: string;
};

/** Validates one command request document or flag draft and checks it targets `command`. */
const parseCommandRequest = Effect.fn('parseCommandRequest')(
  // BOUNDARY: CLI command documents are untrusted JSON; commandRequestSchema validates the complete document and expected command discriminant.
  function* <TCommand extends CommandRequest['command']>(
    command: TCommand,
    value: unknown,
    path: string | undefined,
  ) {
    const parsed = parseWithSchema(commandRequestSchema, value);

    if (!parsed.ok) {
      return yield* new LocalError('cli_usage', 'The command request does not match its schema.', {
        path,
        hint: `Run \`attest help ${command.replaceAll('.', ' ')} --output json\` and repair the input.`,
        details: { diagnostics: schemaIssueDiagnostics(parsed.error.issues) },
      });
    }

    if (parsed.value.command !== command) {
      return yield* new LocalError('cli_usage', 'The command request targets another command.', {
        path: '/command',
        hint: `Set \`command\` to \`${command}\`.`,
      });
    }

    // SAFETY: The complete request schema passed and its command discriminant equals the generic command argument above.
    return parsed.value as CommandRequestFor<TCommand>;
  },
);

/**
 * Validates a request built from CLI flags through the same published schema as `--from-json`,
 * so both input routes reach the command with one shape.
 */
// BOUNDARY: CLI authored drafts are validated through parseCommandRequest before returning a normalized command request.
const validateCommandRequest = <TCommand extends CommandRequest['command']>(
  command: TCommand,
  value: unknown,
) => parseCommandRequest(command, value, undefined);

/**
 * Reads one `--from-json` document from a file or stdin without validating it, for callers that
 * inspect the document before choosing a schema.
 */
const readRequestDocument = Effect.fn('readRequestDocument')(function* (
  source: string,
  options: ReadRequestDocumentOptions,
) {
  const text = yield* readSourceText(source, { ...options, path: '--from-json' });

  return yield* parseJsonText(text, { path: '--from-json', hint: options.hint });
});

/** Reads one `--from-json` request document from a file or stdin and validates it. */
const readCommandRequest = Effect.fn('readCommandRequest')(function* <
  TCommand extends CommandRequest['command'],
>(command: TCommand, source: string, options: ReadCommandRequestOptions) {
  const value = yield* readRequestDocument(source, {
    ...options,
    hint: `Provide one ${COMMAND_REQUEST_SCHEMA_ID} ${command} document.`,
  });

  return yield* parseCommandRequest(command, value, '--from-json');
});

export { readCommandRequest, readRequestDocument, validateCommandRequest };
