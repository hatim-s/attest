import { describe, expect, it } from 'vitest';

import { AttestError } from '../errors/attest-error.js';

class ExampleError extends AttestError {
  declare readonly code: 'EXAMPLE_CODE';

  constructor(message: string, options?: ErrorOptions) {
    super('EXAMPLE_CODE', message, options);
  }
}

describe('AttestError', () => {
  it('exposes a stable code and the subclass name', () => {
    const error = new ExampleError('something broke');
    expect(error.code).toBe('EXAMPLE_CODE');
    expect(error.name).toBe('ExampleError');
    expect(error.message).toBe('something broke');
    expect(error).toBeInstanceOf(AttestError);
    expect(error).toBeInstanceOf(Error);
  });

  it('preserves the causal chain for wrapped failures', () => {
    const cause = new Error('root');
    const error = new ExampleError('wrapped', { cause });
    expect(error.cause).toBe(cause);
  });
});
