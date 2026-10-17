import type { VercelSandboxCredentials } from './credentials.js';
import type { VercelSandboxCreateParams, VercelSandboxFactory, VercelSandboxSdk } from './types.js';

const DEFAULT_IMAGE = 'vercel/sandbox/universal';

const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000;

/** Loads the Vercel SDK lazily so hosts that never use sandboxes do not pay for the import. */
const defaultSandboxFactory: VercelSandboxFactory = async (params) => {
  const { Sandbox } = await import('@vercel/sandbox');

  return Sandbox.create(params);
};

/** Creates one non-persistent VM for a single case with the caller's already checked credentials. */
const createCaseSandbox = (options: {
  credentials: VercelSandboxCredentials;
  factory: VercelSandboxFactory | undefined;
  image: string | undefined;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<VercelSandboxSdk> => {
  const { credentials } = options;

  const params: VercelSandboxCreateParams = {
    image: options.image ?? DEFAULT_IMAGE,
    persistent: false,
    timeout: options.timeoutMs,
    signal: options.signal,
  };

  return (options.factory ?? defaultSandboxFactory)(
    credentials.kind === 'oidc' ? params : { ...params, ...credentials.credentials },
  );
};

/** Stops a case VM within a bounded wait, since an unconfirmed stop may leave a command running. */
const stopCaseSandbox = async (
  sdk: VercelSandboxSdk,
  cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
): Promise<void> => {
  await sdk.stop({ signal: AbortSignal.timeout(cleanupTimeoutMs) });
};

export { DEFAULT_CLEANUP_TIMEOUT_MS, createCaseSandbox, stopCaseSandbox };
