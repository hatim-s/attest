import type { AgentErrorResponse } from '@attest/contracts';

/** BOUNDARY: checks extracted remote error objects before reading message and code. */
const isContainer = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object';

/**
 * BOUNDARY: validates provider error fields against the native message/code contract.
 * Converts an authored error extraction into the native error shape. Agents report errors as a
 * bare string or an object with `message` and optional `code`; anything else keeps the fallback.
 */
const extractRemoteError = (
  value: unknown,
  fallbackMessage: string,
): AgentErrorResponse['error'] => {
  if (typeof value === 'string') return { message: value };

  if (!isContainer(value)) return { message: fallbackMessage };
  const candidate = value;

  if (typeof candidate.message !== 'string') return { message: fallbackMessage };
  const result: AgentErrorResponse['error'] = { message: candidate.message };

  if (typeof candidate.code === 'string') result.code = candidate.code;

  return result;
};

export { extractRemoteError };
