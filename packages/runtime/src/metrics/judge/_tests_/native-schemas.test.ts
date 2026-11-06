import { parseWithSchema, parseWithSchemaSync, SchemaDecodeError } from '@attest/contracts';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { judgeOutputSchema, isUnparseableResponse } from '../internal/structured-output.js';
import { judgeOutcomeSchema } from '../judge-outcome-schema.js';
import { judgeResponseSchema } from '../rubric-prompt.js';

describe('native judge schemas', () => {
  it('exposes concrete structured output inference and rejects extras and nonfinite scores', async () => {
    const result = await judgeOutputSchema['~standard'].validate({ score: 0.75, rationale: 'ok' });

    if ('value' in result)
      expectTypeOf(result.value).toEqualTypeOf<typeof judgeResponseSchema.Type>();
    expect(result).toEqual({ value: { score: 0.75, rationale: 'ok' } });

    for (const value of [
      { score: Infinity, rationale: 'bad' },
      { score: 1, rationale: 'ok', extra: 1 },
    ]) {
      expect(await judgeOutputSchema['~standard'].validate(value)).toHaveProperty('issues');
      expect(parseWithSchema(judgeResponseSchema, value).ok).toBe(false);
    }

    const json = judgeOutputSchema['~standard'].jsonSchema.input({ target: 'draft-2020-12' });
    expect(json).toMatchObject({
      type: 'object',
      required: ['score', 'rationale'],
      additionalProperties: false,
    });
  });

  it('strips cached evidence extras while keeping the verdict strict and SDK events permissive', () => {
    const record = {
      request: { model: 'm', system: 's', user: 'u', params: {}, extra: 1 },
      rawResponse: null,
      attempts: [],
      extra: 1,
    };

    const outcome = parseWithSchemaSync(judgeOutcomeSchema, {
      verdict: { score: 1, rationale: 'ok' },
      record,
      extra: 1,
    });

    expect(outcome.record).not.toHaveProperty('extra');
    expect(outcome.record.request).not.toHaveProperty('extra');
    expect(() =>
      parseWithSchemaSync(judgeOutcomeSchema, {
        ...outcome,
        verdict: { ...outcome.verdict, extra: 1 },
      }),
    ).toThrow(SchemaDecodeError);
    expect(
      isUnparseableResponse(
        Object.assign(new Error('bad'), { code: 'structured-output-parse-failed', extra: 1 }),
      ),
    ).toBe(true);
    expect(isUnparseableResponse({ code: 'other' })).toBe(false);
  });
});
