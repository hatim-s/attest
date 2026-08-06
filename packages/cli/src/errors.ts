import { AttestError } from '@attest/contracts';

type CliErrorCode =
  | 'config_not_found'
  | 'config_read_failed'
  | 'config_parse_failed'
  | 'config_invalid'
  | 'init_conflict'
  | 'init_failed'
  | 'output_exists'
  | 'output_write_failed'
  | 'trace_convert_failed'
  | 'run_failed';

/** Identifies expected CLI boundary failures without exposing internal stack traces. */
class AttestCliError extends AttestError {
  readonly code: CliErrorCode;

  constructor(code: CliErrorCode, message: string, options?: ErrorOptions) {
    super(code, message, options);
    this.code = code;
  }
}

export { AttestCliError, type CliErrorCode };
