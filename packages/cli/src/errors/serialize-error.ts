import { AttestError, type CliError, type CliExitCode } from '@attest/contracts';
import { CommanderError } from 'commander';

import { AttestCliError } from './attest-cli-error.js';
import { getCliErrorDefinition } from './error-catalog.js';

type SerializedCliFailure = {
  error: CliError;
  exitCode: Exclude<CliExitCode, 0>;
};

const definedFields = <T extends Record<string, unknown>>(fields: T): T =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as T;

/** Converts any thrown value to a safe stable CLI error and process exit code. */
const serializeCliError = (error: unknown): SerializedCliFailure => {
  if (error instanceof AttestCliError) {
    const definition = getCliErrorDefinition(error.code);
    if (definition === undefined) {
      throw new Error(`Unregistered CLI error code: ${error.code}`);
    }

    return {
      error: definedFields({
        code: error.code,
        message: error.message,
        path: error.path,
        hint: error.hint,
        retryable: definition.retryable,
        details: error.details,
      }),
      exitCode: definition.exit_code,
    };
  }

  if (error instanceof CommanderError) {
    const definition = getCliErrorDefinition('cli_usage');
    if (definition === undefined) {
      throw new Error('Missing cli_usage error definition.');
    }

    return {
      error: {
        code: definition.code,
        message: error.message,
        hint: definition.repairs[0],
        retryable: definition.retryable,
      },
      exitCode: definition.exit_code,
    };
  }

  const cause = error instanceof AttestError ? error : undefined;
  const definition = getCliErrorDefinition('internal_error');
  if (definition === undefined) {
    throw new Error('Missing internal_error definition.');
  }

  return {
    error: definedFields({
      code: definition.code,
      message:
        cause === undefined
          ? 'The command failed with an unknown internal error.'
          : 'The command failed with an unclassified Attest error.',
      hint: definition.repairs[0],
      retryable: definition.retryable,
      details: cause === undefined ? undefined : { cause_code: cause.code },
    }),
    exitCode: definition.exit_code,
  };
};

/** Renders the human error contract without exposing stacks or causal objects. */
const renderCliError = (error: CliError): string => {
  const lines = [`${error.code}: ${error.message}`];
  if (error.path !== undefined) {
    lines.push(`Path: ${error.path}`);
  }
  if (error.hint !== undefined) {
    lines.push(`Hint: ${error.hint}`);
  }
  return lines.join('\n');
};

export { renderCliError, serializeCliError, type SerializedCliFailure };
