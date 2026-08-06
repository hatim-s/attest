import { AttestError } from '@attest/contracts';

type TraceConversionErrorCode = 'invalid_otlp_json' | 'trace_not_found' | 'ambiguous_trace_export';

/** Identifies malformed or ambiguous trace conversion inputs at the CLI boundary. */
class TraceConversionError extends AttestError {
  readonly code: TraceConversionErrorCode;

  constructor(code: TraceConversionErrorCode, message: string, options?: ErrorOptions) {
    super(code, message, options);
    this.code = code;
  }
}

type ConvertOtlpJsonOptions = {
  traceId?: string;
};

export { TraceConversionError, type ConvertOtlpJsonOptions, type TraceConversionErrorCode };
