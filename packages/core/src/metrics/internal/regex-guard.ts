type GuardedRegexOutcome =
  | { kind: 'matched' }
  | { kind: 'unmatched' }
  | { kind: 'input_too_large'; limitBytes: number }
  | { kind: 'budget_exceeded'; budgetMs: number };

type GuardedRegexOptions = {
  pattern: string;
  flags?: string;
  input: string;
  budgetMs?: number;
  maxInputBytes?: number;
};

const defaultBudgetMs = 100;
const defaultMaximumInputBytes = 262_144;

/**
 * Bounds regex risk because JavaScript cannot preempt a running expression: input is capped before execution,
 * while wall-clock overruns are reported after execution for deterministic assertion evidence.
 */
const executeGuardedRegexTest = (options: GuardedRegexOptions): GuardedRegexOutcome => {
  const maximumInputBytes = options.maxInputBytes ?? defaultMaximumInputBytes;
  if (new TextEncoder().encode(options.input).byteLength > maximumInputBytes) {
    return { kind: 'input_too_large', limitBytes: maximumInputBytes };
  }

  const budgetMs = options.budgetMs ?? defaultBudgetMs;
  const regularExpression = new RegExp(options.pattern, options.flags);
  const startedAt = performance.now();
  const matched = regularExpression.test(options.input);
  const elapsedMs = performance.now() - startedAt;

  if (elapsedMs > budgetMs) {
    return { kind: 'budget_exceeded', budgetMs };
  }

  return matched ? { kind: 'matched' } : { kind: 'unmatched' };
};

export { executeGuardedRegexTest };
