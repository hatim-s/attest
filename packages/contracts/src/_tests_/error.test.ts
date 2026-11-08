import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';

import { AttestError } from '../errors/attest-error.js';
import { tryOwned } from '../errors/try-owned.js';

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

describe('tryOwned', () => {
  const owned = new ExampleError('owned failure');
  const foreign = new TypeError('programming error');

  it('fails with the owned class, mapped when a mapper is given', () => {
    const plain = Effect.runSyncExit(
      tryOwned(ExampleError, () => {
        throw owned;
      }),
    );

    const mapped = Effect.runSyncExit(
      tryOwned(
        ExampleError,
        () => {
          throw owned;
        },
        (error) => error.code,
      ),
    );

    expect(plain).toEqual(Exit.fail(owned));
    expect(mapped).toEqual(Exit.fail('EXAMPLE_CODE'));
  });

  it('keeps anything else as a defect', () => {
    const exit = Effect.runSyncExit(
      tryOwned(
        ExampleError,
        () => {
          throw foreign;
        },
        (error) => error.code,
      ),
    );

    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(foreign);
    expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false);
  });
});
