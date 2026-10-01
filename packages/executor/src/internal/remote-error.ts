import type { AgentErrorResponse } from '@attest/contracts';

/**
 * Converts an authored error extraction into the native error shape. Agents report errors as a
 * bare string or an object with `message` and optional `code`; anything else keeps the fallback.
 */
const extractRemoteError = (
  value: unknown,
  fallbackMessage: string,
): AgentErrorResponse['error'] => {
  if (typeof value === 'string') return { message: value };
  if (value === null || typeof value !== 'object') return { message: fallbackMessage };
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.message !== 'string') return { message: fallbackMessage };
  return {
    message: candidate.message,
    ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
  };
};

export { extractRemoteError };
