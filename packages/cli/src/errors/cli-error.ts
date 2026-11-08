import { AttestError, type CliError, type CliExitCode, type JsonValue } from '@attest/contracts';
import { LocalError, classifyForeignFailure, type LocalInfrastructureFailure } from '@attest/local';
import { StoreError } from '@attest/core';
import { CommanderError } from 'commander';
import * as Cause from 'effect/Cause';
import * as Result from 'effect/Result';

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
 * Every failure a command program can end with. Any `AttestError` subclass, including a future
 * one, renders by design as `unclassified` with its `cause_code`. Only the tagged members outside
 * `AttestError` are checked at compile time: a new one fails `serializeCliFailure`'s exhaustive
 * switch until it gets a rendering.
 */
type CliCommandFailure =
  /** CLI flag, prompt and output failures with catalog codes. */
  | AttestCliError
  /** Local application failures with catalog codes, including project load and transactions. */
  | LocalError
  /** Coded errors from core, executor and runtime that the CLI catalog does not name. */
  | AttestError
  | StoreError
  /** Uncoded filesystem, process and listener failures inside local operations. */
  | LocalInfrastructureFailure
  /** Failures of foreign code: agent transports, metrics, the eval event stream, callbacks. */
  | Cause.UnknownError;

/** What the root renders: a command failure, or Commander's own usage error from parsing. */
type CliFailure = CliCommandFailure | CommanderError;

/** Builds the catalog envelope shared by every internal error. */
const internalFailure = (message: string, details?: JsonValue): SerializedCliFailure => {
  const definition = getCliErrorDefinition('internal_error');

  return {
    error: {
      code: definition.code,
      message,
      hint: definition.repairs[0],
      retryable: definition.retryable,
      details,
    },
    exitCode: definition.exit_code,
  };
};

/** A coded error outside the CLI catalog keeps only its code, under `details.cause_code`. */
const unclassifiedFailure = (code: string): SerializedCliFailure =>
  internalFailure('The command failed with an unclassified Attest error.', { cause_code: code });

/**
 * Maps one typed failure to its catalog error and exit code. An uncoded failure loses its
 * message because it can carry paths, secrets, or stack details.
 */
const serializeCliFailure = (failure: CliFailure): SerializedCliFailure => {
  if (failure instanceof AttestCliError || failure instanceof LocalError) {
    const definition = getCliErrorDefinition(failure.code);

    return {
      error: {
        code: failure.code,
        message: failure.message,
        path: failure.path,
        hint: failure.hint,
        retryable: definition.retryable,
        details: failure.details,
      },
      exitCode: definition.exit_code,
    };
  }

  if (failure instanceof CommanderError) {
    const definition = getCliErrorDefinition('cli_usage');

    return {
      error: {
        code: definition.code,
        message: failure.message,
        hint: definition.repairs[0],
        retryable: definition.retryable,
      },
      exitCode: definition.exit_code,
    };
  }

  if (failure instanceof AttestError) return unclassifiedFailure(failure.code);

  switch (failure._tag) {
    case 'StoreError':
      return unclassifiedFailure(failure.code);
    case 'AnchoredFileFailure':
    case 'AnchoredCleanupFailure':
    case 'ProcessPresenceFailure':
    case 'ViewServerFailure':
    case 'UnknownError':
      return internalFailure('The command failed with an unknown internal error.');
  }
};

/** Maps a squashed Cause, a failure or a defect value, the way `serializeCliFailure` maps it. */
const serializeCliError = (cause: unknown): SerializedCliFailure =>
  serializeCliFailure(cause instanceof CommanderError ? cause : classifyForeignFailure(cause));

/**
 * Maps a failed command Cause. Its first typed failure renders by type; only a Cause without one,
 * a defect or an interruption, renders its squashed value. `Cause.squash` also picks the first
 * failure, so both paths report the same value.
 */
const serializeCliCause = (cause: Cause.Cause<CliFailure>): SerializedCliFailure => {
  const failure = Cause.findError(cause);

  return Result.isSuccess(failure)
    ? serializeCliFailure(failure.success)
    : serializeCliError(Cause.squash(cause));
};

/** Renders an error for stderr as code, message, path, and hint lines, never a stack. */
const renderCliError = (error: CliError): string => {
  const lines = [`${error.code}: ${error.message}`];

  if (error.path !== undefined) lines.push(`Path: ${error.path}`);

  if (error.hint !== undefined) lines.push(`Hint: ${error.hint}`);

  return lines.join('\n');
};

export {
  AttestCliError,
  renderCliError,
  serializeCliCause,
  serializeCliError,
  serializeCliFailure,
  type CliCommandFailure,
  type CliFailure,
  type SerializedCliFailure,
};
