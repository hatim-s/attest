import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  CONTRACT_JSON_SCHEMAS,
  serializeContractSchema,
} from '../packages/contracts/src/json-schema.js';

const outputDirectory = resolve(import.meta.dir, '../packages/schemas/generated');

/** Writes every public contract schema to the generated schema package. */
const generateJsonSchemas = async (): Promise<void> => {
  await mkdir(outputDirectory, { recursive: true });

  for (const fileName of CONTRACT_JSON_SCHEMAS.keys()) {
    await Bun.write(resolve(outputDirectory, fileName), serializeContractSchema(fileName));
  }
};

await generateJsonSchemas();
