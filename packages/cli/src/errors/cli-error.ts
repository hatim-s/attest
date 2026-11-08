import { AttestError, type CliError, type CliExitCode, type JsonValue } from '@attest/contracts';
import { LocalError } from '@attest/local';
import { StoreError } from '@attest/core';
import { CommanderError } from 'commander';

import { getCliErrorDefinition, type CliErrorCode } from './error-catalog.js';

type AttestCliErrorOptions = ErrorOptions & {
  path?: string;
  hint?: string;
  details?: JsonValue;
};

type SerializedCliFailure = {
  error: CliError;
  exitCode: Exclude<CliExitCode, 0>;
};

/** A failure the CLI expects, carrying only fields that are safe to print or serialize. */
class AttestCliError extends AttestError {
  readonly code: CliErrorCode;
  readonly path: string | undefined;
  readonly hint: string | undefined;
  readonly details: JsonValue | undefined;

  constructor(code: CliErrorCode, message: string, options?: AttestCliErrorOptions) {
    super(code, message, options);
    this.code = code;
    this.path = options?.path;
    this.hint = options?.hint;
    this.details = options?.details;
  }
}

/**
 * Maps any thrown value to a catalog error and exit code. Unknown errors lose their message
 * because it can carry paths, secrets, or stack details.
 */
const serializeCliError = (cause: unknown): SerializedCliFailure => {
  if (cause instanceof AttestCliError || cause instanceof LocalError) {
    const definition = getCliErrorDefinition(cause.code);

    return {
      error: {
        code: cause.code,
        message: cause.message,
        path: cause.path,
        hint: cause.hint,
        retryable: definition.retryable,
        details: cause.details,
      },
      exitCode: definition.exit_code,
    };
  }

  if (cause instanceof CommanderError) {
    const definition = getCliErrorDefinition('cli_usage');

    return {
      error: {
        code: definition.code,
        message: cause.message,
        hint: definition.repairs[0],
        retryable: definition.retryable,
      },
      exitCode: definition.exit_code,
    };
  }

  const definition = getCliErrorDefinition('internal_error');

  const applicationCause =
    cause instanceof AttestError || cause instanceof StoreError ? cause : undefined;

  return {
    error: {
      code: definition.code,
      message:
        applicationCause === undefined
          ? 'The command failed with an unknown internal error.'
          : 'The command failed with an unclassified Attest error.',
      hint: definition.repairs[0],
      retryable: definition.retryable,
      details: applicationCause === undefined ? undefined : { cause_code: applicationCause.code },
    },
    exitCode: definition.exit_code,
  };
};

/** Renders an error for stderr as code, message, path, and hint lines, never a stack. */
const renderCliError = (error: CliError): string => {
  const lines = [`${error.code}: ${error.message}`];

  if (error.path !== undefined) lines.push(`Path: ${error.path}`);

  if (error.hint !== undefined) lines.push(`Hint: ${error.hint}`);

  return lines.join('\n');
};

export { AttestCliError, renderCliError, serializeCliError, type SerializedCliFailure };
