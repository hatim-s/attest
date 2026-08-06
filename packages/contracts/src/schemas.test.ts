import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  agentRequestSchema,
  agentResponseSchema,
  configSchema,
  metricRequestSchema,
  metricResultSchema,
  traceSchema,
} from './index.js';
import { postProcessJsonSchema } from './json-schema-postprocess.js';

const generatedDirectory = resolve(import.meta.dirname, '../../schemas/generated');
const schemas = {
  'agent-request.v1alpha1.json': agentRequestSchema,
  'agent-response.v1alpha1.json': agentResponseSchema,
  'trace.v1alpha1.json': traceSchema,
  'config.v1.json': configSchema,
  'metric-request.v1alpha1.json': metricRequestSchema,
  'metric-result.v1alpha1.json': metricResultSchema,
};

const sortObjectKeys = (_key: string, value: unknown): unknown => {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => {
      if (left === right) {
        return 0;
      }

      return left < right ? -1 : 1;
    }),
  );
};

describe('generated JSON Schemas', () => {
  it.each(Object.entries(schemas))('%s matches its in-memory schema', async (fileName, schema) => {
    const jsonSchema = postProcessJsonSchema(
      schema.toJSONSchema({ target: 'draft-2020-12' }),
      fileName,
    );
    const inMemory = `${JSON.stringify(jsonSchema, sortObjectKeys, 2)}\n`;
    const generated = await readFile(resolve(generatedDirectory, fileName), 'utf8');

    expect(generated, 'generated JSON Schema drifted; run generate:schemas').toBe(inMemory);
  });
});
