import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it, vi } from 'vitest';

import { evaluateJsonSchemaCheck } from '../json-schema-check.js';

describe('evaluateJsonSchemaCheck', () => {
  it('compiles each boolean schema once and preserves its validation result', () => {
    const compile = vi.spyOn(Ajv2020.Ajv2020.prototype, 'compile');

    for (let index = 0; index < 3; index += 1) {
      expect(
        evaluateJsonSchemaCheck(
          { path: '$.output', schema: true },
          { found: true, value: { index } },
        ),
      ).toEqual({ passed: true });
      const rejected = evaluateJsonSchemaCheck(
        { path: '$.output', schema: false },
        { found: true, value: { index } },
      );
      expect(rejected.passed).toBe(false);
      expect(rejected.reason).toContain(
        'value at $.output failed JSON Schema validation: data boolean schema is false',
      );
    }

    expect(compile).toHaveBeenCalledTimes(2);
    compile.mockRestore();
  });
});
