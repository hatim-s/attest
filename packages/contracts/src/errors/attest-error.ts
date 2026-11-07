/**
 * Base class for Attest errors that have not migrated to native tagged errors.
 *
 * Carries a stable machine-readable `code` so CLI rendering, telemetry, and
 * tests can branch on identity without parsing messages. Each package defines
 * subclasses that narrow `code` to their own unions. Native tagged errors retain their
 * own identity and stable code, such as StoreError.
 */
abstract class AttestError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export { AttestError };
