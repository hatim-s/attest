import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  agentRequestSchema,
  agentResponseSchema,
  configSchema,
  metricRequestSchema,
  metricResultSchema,
  traceSchema,
} from '../packages/contracts/src/index.js';
import { postProcessJsonSchema } from '../packages/contracts/src/json-schema-postprocess.js';

const outputDirectory = resolve(import.meta.dir, '../packages/schemas/generated');
const schemas = {
  'agent-request.v1alpha1.json': agentRequestSchema,
  'agent-response.v1alpha1.json': agentResponseSchema,
  'trace.v1alpha1.json': traceSchema,
  'config.v1.json': configSchema,
  'metric-request.v1alpha1.json': metricRequestSchema,
  'metric-result.v1alpha1.json': metricResultSchema,
};

/** Sorts object keys at every depth so generated schemas are byte-stable across runs. */
const sortObjectKeys = (_key: string, value: unknown): unknown => {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    return value;
  }

  const entries = Object.entries(value).sort(([left], [right]) => {
    if (left === right) {
      return 0;
    }

    return left < right ? -1 : 1;
  });
  return Object.fromEntries(entries);
};

/** Serializes a Zod schema as deterministic Draft 2020-12 JSON Schema. */
const serializeSchema = (
  schema: (typeof schemas)[keyof typeof schemas],
  fileName: string,
): string => {
  const jsonSchema = schema.toJSONSchema({ target: 'draft-2020-12' });
  postProcessJsonSchema(jsonSchema, fileName);
  return `${JSON.stringify(jsonSchema, sortObjectKeys, 2)}\n`;
};

/** Writes every public contract schema to the generated schema package. */
const generateJsonSchemas = async (): Promise<void> => {
  await mkdir(outputDirectory, { recursive: true });

  for (const [fileName, schema] of Object.entries(schemas)) {
    await Bun.write(resolve(outputDirectory, fileName), serializeSchema(schema, fileName));
  }
};

await generateJsonSchemas();
