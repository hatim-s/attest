import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { JsonValue } from '@attest/contracts';

import type { JudgeRequest } from './judge-client.js';
import { computeJudgeCacheKey } from './judge-cache.js';
import { JUDGE_PROMPT_VERSION } from './rubric-prompt.js';

const jsonObjectArbitrary: fc.Arbitrary<Record<string, JsonValue>> = fc.dictionary(
  fc.string(),
  fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
);

/** Rebuilds objects in reverse insertion order while preserving the same logical JSON value. */
const reverseObjectInsertionOrder = (value: JsonValue): JsonValue => {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(reverseObjectInsertionOrder);
  }
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, child]) => [key, reverseObjectInsertionOrder(child)]),
  );
};

/** Builds a complete judge request around generated JSON evidence. */
const createRequest = (document: JsonValue): JudgeRequest => ({
  model: 'openai/gpt-test',
  rubric: 'Score correctness.',
  document: { input: document, output: document, expected: document, traceSummary: undefined },
});

describe('computeJudgeCacheKey', () => {
  it('is invariant under JSON object key insertion order', () => {
    fc.assert(
      fc.property(jsonObjectArbitrary, (document) => {
        const reordered = reverseObjectInsertionOrder(document);
        expect(computeJudgeCacheKey(createRequest(document))).toBe(
          computeJudgeCacheKey(createRequest(reordered)),
        );
      }),
    );
  });

  it('changes when rubric, model, or document changes', () => {
    fc.assert(
      fc.property(
        jsonObjectArbitrary,
        fc.tuple(fc.string(), fc.string()).filter(([first, second]) => first !== second),
        (base, [first, second]) => {
          const request = createRequest({ base, discriminator: first });
          const baselineRequest = {
            ...request,
            model: `provider/${first}`,
            rubric: `rubric/${first}`,
          };
          const baseline = computeJudgeCacheKey(baselineRequest);

          expect(computeJudgeCacheKey({ ...baselineRequest, rubric: `rubric/${second}` })).not.toBe(
            baseline,
          );
          expect(
            computeJudgeCacheKey({ ...baselineRequest, model: `provider/${second}` }),
          ).not.toBe(baseline);
          expect(
            computeJudgeCacheKey({
              ...createRequest({ base, discriminator: second }),
              model: `provider/${first}`,
              rubric: `rubric/${first}`,
            }),
          ).not.toBe(baseline);
        },
      ),
    );
  });

  it('invalidates the same rendered request when the prompt policy version changes', () => {
    const request = createRequest({ answer: 'Paris' });

    expect(computeJudgeCacheKey(request, { promptVersion: JUDGE_PROMPT_VERSION + 1 })).not.toBe(
      computeJudgeCacheKey(request),
    );
  });
});
