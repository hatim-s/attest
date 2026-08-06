/** Raised for defensive invariant violations inside metric evaluation because config is validated upstream. */
class AttestMetricError extends Error {
  readonly code: 'invalid_path';

  constructor(code: AttestMetricError['code'], message: string) {
    super(message);
    this.name = 'AttestMetricError';
    this.code = code;
  }
}

export { AttestMetricError };
