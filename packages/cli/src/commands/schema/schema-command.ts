import {
  COMMAND_REQUEST_SCHEMA_ID,
  CONTRACT_JSON_SCHEMAS,
  METRIC_PRESET_SCHEMA_ID,
  METRIC_TEST_FIXTURE_SCHEMA_ID,
  serializeContractSchema,
  type JsonValue,
} from '@attest/contracts';

import { AttestCliError } from '../../errors/cli-error.js';

type SchemaListItem = {
  file: string;
  id: string;
};

type SchemaListResult = {
  items: SchemaListItem[];
};

type SchemaPrintResult = SchemaListItem & {
  schema: JsonValue;
};

/** Public schema ids whose generated file name differs from the id. */
const FILE_BY_SCHEMA_ID: Readonly<Record<string, string>> = {
  [COMMAND_REQUEST_SCHEMA_ID]: 'command-request.json',
  [METRIC_PRESET_SCHEMA_ID]: 'metric-preset.json',
  [METRIC_TEST_FIXTURE_SCHEMA_ID]: 'metric-test-fixture.json',
};

const SCHEMA_ID_BY_FILE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(FILE_BY_SCHEMA_ID).map(([id, file]) => [file, id]),
);

const schemaIdForFile = (file: string): string => SCHEMA_ID_BY_FILE[file] ?? file;

/** Lists the generated schema registry sorted by public id. */
const runSchemaListCommand = (): SchemaListResult => ({
  items: [...CONTRACT_JSON_SCHEMAS.keys()]
    .map((file) => ({ file, id: schemaIdForFile(file) }))
    .sort((left, right) => left.id.localeCompare(right.id)),
});

/** Reads one generated schema by its public id or its file name. */
const runSchemaPrintCommand = (schemaId: string): SchemaPrintResult => {
  const file = FILE_BY_SCHEMA_ID[schemaId] ?? schemaId;
  if (!CONTRACT_JSON_SCHEMAS.has(file)) {
    throw new AttestCliError('resource_not_found', `schema ${schemaId} was not found.`, {
      path: schemaId,
      hint: 'Run `attest schema list --output json` to inspect registered schema ids.',
    });
  }
  const schema = JSON.parse(serializeContractSchema(file)) as JsonValue;
  return { file, id: schemaIdForFile(file), schema };
};

/** Prints one id per line, with the file name when it differs from the id. */
const renderSchemaList = (result: SchemaListResult): string =>
  result.items.map(({ file, id }) => `  ${id}${id === file ? '' : `  (${file})`}`).join('\n');

/** Prints the schema document itself, indented for reading. */
const renderSchemaPrint = (result: SchemaPrintResult): string =>
  JSON.stringify(result.schema, undefined, 2);

export { renderSchemaList, renderSchemaPrint, runSchemaListCommand, runSchemaPrintCommand };
