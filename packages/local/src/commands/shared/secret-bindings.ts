import { LocalError } from '../../errors/index.js';

/** Parses repeatable `NAME=VALUE` flags into a record; a repeated name keeps the last value. */
const parseNameValuePairs = (values: readonly string[], path: string, hint: string) => {
  const pairs: Record<string, string> = {};

  for (const value of values) {
    const separator = value.indexOf('=');
    const name = value.slice(0, separator).trim();
    const content = value.slice(separator + 1).trim();

    if (separator <= 0 || name.length === 0 || content.length === 0) {
      throw new LocalError('cli_usage', `Invalid ${path} value: ${value}.`, { path, hint });
    }

    pairs[name] = content;
  }

  return pairs;
};

/**
 * Parses repeatable `TARGET=SOURCE_ENV` flags into environment secret references. Only the
 * environment variable name is stored; the secret value is read at invocation time.
 */
const parseSecretBindings = (values: readonly string[], path: string) =>
  Object.fromEntries(
    Object.entries(
      parseNameValuePairs(
        values,
        path,
        'Use TARGET_NAME=SOURCE_ENV; only the environment variable name is stored.',
      ),
    ).map(([target, source]) => [target, { from_env: source }]),
  );

export { parseNameValuePairs, parseSecretBindings };
