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

  it('rejects models absent from the installed provider declaration', async () => {
    const client = createTanstackJudgeClient();

    const unsupportedModelRequest = {
      ...request,
      model: 'openai/not-in-this-sdk-version',
    };
    await expect(client.scoreRubric(unsupportedModelRequest)).rejects.toHaveProperty(
      'code',
      'judge_provider_error',
    );
    await expect(client.scoreRubric(unsupportedModelRequest)).rejects.toThrow('not supported');
  });
});
