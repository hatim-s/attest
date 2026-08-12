import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const generatedDirectory = new URL('../../generated/', import.meta.url);
const draft2020Schema = 'https://json-schema.org/draft/2020-12/schema';

/** Validates that every generated artifact is parseable Draft 2020-12 JSON Schema. */
async function validateArtifacts(): Promise<void> {
  const artifactNames = await readdir(generatedDirectory, { withFileTypes: true });

  for (const artifact of artifactNames) {
    if (!artifact.isFile() || !artifact.name.endsWith('.json')) {
      continue;
    }

    const artifactUrl = new URL(join(artifact.name), generatedDirectory);
    const document = JSON.parse(await readFile(artifactUrl, 'utf8')) as {
      $schema?: unknown;
    };

    if (document.$schema !== draft2020Schema) {
      throw new Error(
        `${artifact.name} must declare ${draft2020Schema}, received ${String(document.$schema)}`,
      );
    }
  }
}

await validateArtifacts();
