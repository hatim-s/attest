import {
  COMMAND_REQUEST_SCHEMA_VERSION,
  CONTRACT_JSON_SCHEMAS,
  serializeContractSchema,
} from '@attest/contracts';

import { AttestCliError } from '../../errors.js';
import type { JsonValue } from '../../project/canonical-project.js';
import type { CommandResult } from '../command-result.js';

const schemaAliases = new Map<string, string>([
  [COMMAND_REQUEST_SCHEMA_VERSION, 'command-request.v2.json'],
]);

const schemaIdForFile = (file: string): string =>
  [...schemaAliases.entries()].find(([, candidate]) => candidate === file)?.[0] ?? file;

/** Lists the generated runtime schema registry in deterministic identifier order. */
const runSchemaListCommand = (): CommandResult => {
  const items = [...CONTRACT_JSON_SCHEMAS.keys()]
    .map((file) => ({ file, id: schemaIdForFile(file) }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    human: items.map(({ file, id }) => `  ${id}${id === file ? '' : `  (${file})`}`).join('\n'),
    projectHashBefore: null,
    projectHashAfter: null,
    result: { items },
  };
};

/** Retrieves one exact generated schema by its public id or registered filename. */
const runSchemaPrintCommand = (schemaId: string): CommandResult => {
  const file = schemaAliases.get(schemaId) ?? schemaId;
  if (!CONTRACT_JSON_SCHEMAS.has(file)) {
    throw new AttestCliError('resource_not_found', `schema ${schemaId} was not found.`, {
      path: schemaId,
      hint: 'Run `attest schema list --output json` to inspect registered schema ids.',
    });
  }
  const id = schemaIdForFile(file);
  const schema = JSON.parse(serializeContractSchema(file)) as JsonValue;
  return {
    human: serializeContractSchema(file).trimEnd(),
    projectHashBefore: null,
    projectHashAfter: null,
    result: { file, id, schema },
  };
};

export { runSchemaListCommand, runSchemaPrintCommand };
