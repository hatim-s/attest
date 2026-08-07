import { AttestError, type JsonValue } from '@attest/contracts';

import { getCliErrorDefinition, type CliErrorCode } from './error-catalog.js';

type AttestCliErrorOptions = ErrorOptions & {
  path?: string;
  hint?: string;
  details?: JsonValue;
};

/** Identifies an expected CLI failure and carries only safe structured output fields. */
class AttestCliError extends AttestError {
  readonly code: CliErrorCode;
  readonly retryable: boolean;
  readonly path: string | undefined;
  readonly hint: string | undefined;
  readonly details: JsonValue | undefined;

  constructor(code: CliErrorCode, message: string, options?: AttestCliErrorOptions) {
    super(code, message, options);
    const definition = getCliErrorDefinition(code);
    if (definition === undefined) {
      throw new Error(`Unregistered CLI error code: ${code}`);
    }

    this.code = code;
    this.retryable = definition.retryable;
    this.path = options?.path;
    this.hint = options?.hint;
    this.details = options?.details;
  }
}

export { AttestCliError, type AttestCliErrorOptions };
