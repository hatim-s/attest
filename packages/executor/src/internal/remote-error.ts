import { isJsonObject, isString, type AgentErrorResponse, type JsonValue } from '@attest/contracts';

/**
 * Converts an authored error extraction into the native error shape. Agents report errors as a
 * bare string or an object with `message` and optional `code`; anything else keeps the fallback.
 */
const extractRemoteError = (
  value: JsonValue,
  fallbackMessage: string,
): AgentErrorResponse['error'] => {
  if (isString(value)) return { message: value };

  if (!isJsonObject(value) || !isString(value.message)) return { message: fallbackMessage };
  const result: AgentErrorResponse['error'] = { message: value.message };

  if (isString(value.code)) result.code = value.code;

  return result;
};

export { extractRemoteError };
