import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CONTRACT_JSON_SCHEMAS, serializeContractSchema } from '../schema/json-schema.js';

const generatedDirectory = resolve(import.meta.dirname, '../../../schemas/generated');

describe('generated JSON Schemas', () => {
  it.each([...CONTRACT_JSON_SCHEMAS.keys()])(
    '%s matches its runtime serializer',
    async (fileName) => {
      const serialized = serializeContractSchema(fileName);
      const committed = await readFile(resolve(generatedDirectory, fileName), 'utf8');

      expect(committed, 'generated JSON Schema drifted; run generate:schemas').toBe(serialized);
    },
  );
});
