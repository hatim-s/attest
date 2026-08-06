import { AttestError } from '@attest/contracts';

/** Raised for defensive invariant violations inside metric evaluation because config is validated upstream. */
class AttestMetricError extends AttestError {
  declare readonly code: 'invalid_path';

  constructor(code: AttestMetricError['code'], message: string) {
    super(code, message);
  }
}

export { AttestMetricError };
