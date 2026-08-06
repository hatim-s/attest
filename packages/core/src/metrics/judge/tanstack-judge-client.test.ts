import { describe, expect, it } from 'vitest';

import { AttestMetricError } from '../errors.js';
import type { JudgeRequest } from './judge-client.js';
import { createTanstackJudgeClient, parseJudgeModel } from './tanstack-judge-client.js';

const request: JudgeRequest = {
  model: 'unsupported/model',
  rubric: 'Score correctness.',
  document: { input: {}, output: {}, expected: {}, traceSummary: undefined },
};

describe('parseJudgeModel', () => {
  it('keeps the provider and full model suffix', () => {
    expect(parseJudgeModel('openai/family/model')).toEqual({
      provider: 'openai',
      model: 'family/model',
    });
  });

  it('accepts a provider-qualified model string that the SDK does not yet enumerate', () => {
    expect(parseJudgeModel('anthropic/future-model-2027')).toEqual({
      provider: 'anthropic',
      model: 'future-model-2027',
    });
  });

  it.each(['model-only', '/model', 'openai/', 'unsupported/model'])(
    'rejects invalid model %s',
    (model) => {
      expect(() => parseJudgeModel(model)).toThrow(AttestMetricError);
      try {
        parseJudgeModel(model);
      } catch (error: unknown) {
        expect(error).toHaveProperty('code', 'judge_provider_error');
      }
    },
  );
});

describe('createTanstackJudgeClient', () => {
  it('rejects an unknown provider before any SDK or network call', async () => {
    const client = createTanstackJudgeClient();

    await expect(client.scoreRubric(request)).rejects.toHaveProperty(
      'code',
      'judge_provider_error',
    );
    await expect(client.scoreRubric(request)).rejects.toThrow('unsupported');
  });
});
