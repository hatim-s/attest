import * as Data from 'effect/Data';

/**
 * Base class for Attest errors that have not migrated to native tagged errors.
 *
 * Carries a stable machine-readable `code` so CLI rendering, telemetry, and
 * tests can branch on identity without parsing messages. Each package defines
 * subclasses that narrow `code` to their own unions. Native tagged errors retain their
 * own identity and stable code, such as StoreError.
 */
abstract class AttestError extends Data.Error {
  readonly code: string;

  /** Lets JSON.stringify apply its native property and replacer rules to this Error. */
  override toJSON() {
    return this;
  }

  /** Returning this lets Node format the native Error message, stack and cause. */
  [Symbol.for('nodejs.util.inspect.custom')]() {
    return this;
  }

  constructor(code: string, message: string, options?: ErrorOptions) {
    super();
    // Native Error keeps message and cause as non-enumerable own properties.
    void Object.defineProperty(this, 'message', {
      configurable: true,
      enumerable: false,
      value: message,
      writable: true,
    });

    if (options && 'cause' in options) {
      void Object.defineProperty(this, 'cause', {
        configurable: true,
        enumerable: false,
        value: options.cause,
        writable: true,
      });
    }

    this.name = new.target.name;
    this.code = code;
  }
}

export { AttestError };
