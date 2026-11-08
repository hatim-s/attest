import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';

import { AttestError } from '../errors/attest-error.js';

class ExampleError extends AttestError {
  declare readonly code: 'EXAMPLE_CODE';
  readonly hint: string | undefined;

  constructor(message: string, options?: ErrorOptions & { hint?: string }) {
    super('EXAMPLE_CODE', message, options);
    this.hint = options?.hint;
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
    expect(inspect(error)).toContain('wrapped');
    expect(inspect(error)).toContain('root');
    expect(JSON.stringify(error, ['message', 'cause'])).toBe(
      JSON.stringify(new Error('wrapped', { cause }), ['message', 'cause']),
    );
  });

  it('keeps native Error fields private without exposing their cause', () => {
    const cause = { secret: true };
    const error = new ExampleError('wrapped', { cause, hint: 'retry later' });

    expect(Object.keys(error)).toEqual(['code', 'name', 'hint']);
    expect(JSON.stringify(error)).toBe(
      '{"code":"EXAMPLE_CODE","name":"ExampleError","hint":"retry later"}',
    );
    expect(error.message).toBe('wrapped');
    expect(error.cause).toBe(cause);
    expect(String(error)).toBe('ExampleError: wrapped');
    expect(error.stack).toBeTruthy();

    for (const property of ['message', 'cause']) {
      expect(Object.getOwnPropertyDescriptor(error, property)).toMatchObject({
        configurable: true,
        enumerable: false,
        writable: true,
      });
    }
  });
});
