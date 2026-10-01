/**
 * Base class for every error attest raises across packages.
 *
 * Carries a stable machine-readable `code` so CLI rendering, telemetry, and
 * tests can branch on identity without parsing messages. Each package defines
 * one subclass that narrows `code` to its own union, e.g. `StoreError extends AttestError`.
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
