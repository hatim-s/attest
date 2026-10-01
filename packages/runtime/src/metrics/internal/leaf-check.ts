import type { LeafAssertionCheck } from '@attest/contracts';

/** One leaf check's verdict; the reason explains a failure. */
type CheckEvaluation = { passed: boolean; reason?: string };

/** Selects one leaf check's payload by its key, for example `LeafCheck<'regex'>`. */
type LeafCheck<Key extends string> = LeafAssertionCheck extends infer Check
  ? Check extends Record<Key, infer Payload>
    ? Payload
    : never
  : never;

export { type CheckEvaluation, type LeafCheck };
