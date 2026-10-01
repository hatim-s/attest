import { LocalError } from '../../errors/index.js';

/**
 * Parses repeatable `TARGET=SOURCE_ENV` flags into environment secret references. Only the
 * environment variable name is stored; the secret value is read at invocation time.
 */
const parseSecretBindings = (
  values: readonly string[],
  path: string,
): Record<string, { from_env: string }> => {
  const bindings: Record<string, { from_env: string }> = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    const target = value.slice(0, separator).trim();
    const source = value.slice(separator + 1).trim();
    if (separator <= 0 || target.length === 0 || source.length === 0) {
      throw new LocalError('cli_usage', `Invalid secret binding: ${value}.`, {
        path,
        hint: 'Use TARGET_NAME=SOURCE_ENV; only the environment variable name is stored.',
      });
    }
    bindings[target] = { from_env: source };
  }
  return bindings;
};

export { parseSecretBindings };
