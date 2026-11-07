import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import { foreign } from '../../isolation/operation.js';
import type { VercelSandboxCredentials } from './credentials.js';
import type { VercelSandboxCreateParams, VercelSandboxFactory, VercelSandboxSdk } from './types.js';

const DEFAULT_IMAGE = 'vercel/sandbox/universal';

const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000;

/** Acquires one VM, waiting for the SDK's creation receipt before transferring ownership. */
const createCaseSandbox = Effect.fn('createCaseSandbox')(function* (options: {
  credentials: VercelSandboxCredentials;
  factory: VercelSandboxFactory | undefined;
  image: string | undefined;
  timeoutMs: number;
  signal: AbortSignal;
}) {
  const params: VercelSandboxCreateParams = {
    image: options.image ?? DEFAULT_IMAGE,
    persistent: false,
    timeout: options.timeoutMs,
    signal: options.signal,
  };

  const paramsWithCredentials =
    options.credentials.kind === 'oidc'
      ? params
      : { ...params, ...options.credentials.credentials };

  if (options.factory)
    return yield* foreign((foreignSignal) =>
      options.factory!({
        ...paramsWithCredentials,
        signal: AbortSignal.any([foreignSignal, options.signal]),
      }),
    );
  const { Sandbox } = yield* foreign(() => import('@vercel/sandbox'));

  return yield* foreign((foreignSignal) =>
    Sandbox.create({
      ...paramsWithCredentials,
      signal: AbortSignal.any([foreignSignal, options.signal]),
    }),
  );
});

/** A bounded wait reports uncertainty; it never asserts that the remote VM stopped. */
const stopCaseSandbox = Effect.fn('stopCaseSandbox')(function* (
  sdk: VercelSandboxSdk,
  cleanupTimeoutMs: number = DEFAULT_CLEANUP_TIMEOUT_MS,
) {
  const stopped = yield* Effect.timeoutOption(
    Effect.interruptible(
      foreign((foreignSignal) =>
        sdk.stop({
          signal: AbortSignal.any([foreignSignal, AbortSignal.timeout(cleanupTimeoutMs)]),
        }),
      ),
    ),
    cleanupTimeoutMs,
  );

  if (Option.isNone(stopped))
    return yield* Effect.fail(
      new Error('Sandbox stop was not confirmed before cleanup timed out.'),
    );
});

export { DEFAULT_CLEANUP_TIMEOUT_MS, createCaseSandbox, stopCaseSandbox };
