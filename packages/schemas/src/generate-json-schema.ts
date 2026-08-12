import { mkdir, writeFile } from 'node:fs/promises';

import { CONTRACT_JSON_SCHEMAS, serializeContractSchema } from '@attest/contracts';

const outputDirectory = new URL('../generated/', import.meta.url);

/** Writes every public contract schema to the generated schema package. */
const generateJsonSchemas = async (): Promise<void> => {
  await mkdir(outputDirectory, { recursive: true });

  for (const fileName of CONTRACT_JSON_SCHEMAS.keys()) {
    await writeFile(new URL(fileName, outputDirectory), serializeContractSchema(fileName));
  }
};

await generateJsonSchemas();
