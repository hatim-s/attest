import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

import { CONTRACT_JSON_SCHEMAS, serializeContractSchema } from '@attest/contracts';

const generatedDirectory = new URL('../../generated/', import.meta.url);

/** Checks the complete published schema set against its authoritative contract definitions. */
const validateArtifacts = async (): Promise<void> => {
  const expected = [...CONTRACT_JSON_SCHEMAS.keys()].sort();
  const actual = (await readdir(generatedDirectory))
    .filter((name) => name.endsWith('.json'))
    .sort();
  assert.deepEqual(actual, expected, 'Generated schema files differ from the contract registry.');

  for (const fileName of expected) {
    const artifact = await readFile(new URL(fileName, generatedDirectory), 'utf8');
    assert.equal(
      artifact,
      serializeContractSchema(fileName),
      `${fileName} is stale. Run bun run generate:schemas.`,
    );
  }
};

await validateArtifacts();
