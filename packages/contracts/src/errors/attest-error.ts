/**
 * Base class for every error attest raises across packages.
 *
 * Carries a stable machine-readable `code` so CLI rendering, telemetry, and
 * tests can branch on identity without parsing messages. Subclasses narrow
 * `code` to their own union (see PLAN 0A.5 / docs/TASTE.md "Errors"): packages
 * define one taxonomy class each, e.g. `StoreError extends AttestError`.
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
