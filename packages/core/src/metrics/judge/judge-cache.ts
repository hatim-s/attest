import { createHash } from 'node:crypto';

import type { JsonValue } from '@attest/contracts';

import type { JudgeRequest, JudgeVerdict } from './judge-client.js';

/** Stores durable judge evidence behind an advisory content-addressed cache boundary. */
type JudgeCacheEntry = { verdict: JudgeVerdict; record: JsonValue };

/** Lets run stores avoid repeated provider calls when metric spec §3 inputs have not changed. */
interface JudgeCache {
  get(key: string): Promise<JudgeCacheEntry | undefined>;
  set(key: string, entry: JudgeCacheEntry): Promise<void>;
}

/** Serializes JSON recursively with sorted object keys so equivalent request data receives one cache key. */
const stableStringify = (value: JsonValue): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key]!)}`)
    .join(',')}}`;
};

/**
 * Hashes exactly the judge inputs that make spec §3's case, output, and rubric unchanged, avoiding repeat calls.
 */
const computeJudgeCacheKey: (request: JudgeRequest) => string = (request) =>
  createHash('sha256')
    .update(
      stableStringify({
        model: request.model,
        rubric: request.rubric,
        document: {
          input: request.document.input,
          ...(request.document.output === undefined ? {} : { output: request.document.output }),
          ...(request.document.expected === undefined
            ? {}
            : { expected: request.document.expected }),
          ...(request.document.traceSummary === undefined
            ? {}
            : { traceSummary: request.document.traceSummary }),
        },
      }),
    )
    .digest('hex');

export { computeJudgeCacheKey, type JudgeCache, type JudgeCacheEntry };
