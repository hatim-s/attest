type GuardedRegexOutcome =
  { kind: 'matched' } | { kind: 'unmatched' } | { kind: 'input_too_large'; limitBytes: number };

type GuardedRegexOptions = {
  pattern: string;
  flags?: string;
  input: string;
  maxInputBytes?: number;
};

const defaultMaximumInputBytes = 65_536;

/**
 * Applies the deterministic pre-execution input cap for user-configured JavaScript regular expressions.
 */
const executeGuardedRegexTest = (options: GuardedRegexOptions): GuardedRegexOutcome => {
  const maximumInputBytes = options.maxInputBytes ?? defaultMaximumInputBytes;
  if (new TextEncoder().encode(options.input).byteLength > maximumInputBytes) {
    return { kind: 'input_too_large', limitBytes: maximumInputBytes };
  }

  const regularExpression = new RegExp(options.pattern, options.flags);
  const matched = regularExpression.test(options.input);
  return matched ? { kind: 'matched' } : { kind: 'unmatched' };
};

export { executeGuardedRegexTest };
