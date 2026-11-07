import { parseWithSchemaSync } from '../../schema/parse.js';
import * as Schema from 'effect/Schema';
import * as formatsModule from 'ajv-formats';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';

import { serializeContractSchema } from '../../schema/json-schema.js';

const ajv = new Ajv2020({ allErrors: true, strict: false });

formatsModule.default.default(ajv);

// Wire identifiers use Crockford base32, either case.
ajv.addFormat('ulid', /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/u);

const validators = new Map<string, ValidateFunction>();

/** Compiles the serializer output for one published schema file, so tests check what ships. */
const compileGeneratedSchema = (fileName: string): ValidateFunction => {
  const cached = validators.get(fileName);

  if (cached !== undefined) {
    return cached;
  }

  const validator = ajv.compile(
    parseWithSchemaSync(
      Schema.Record(Schema.String, Schema.Json),
      JSON.parse(serializeContractSchema(fileName)),
    ),
  );

  validators.set(fileName, validator);

  return validator;
};

export { compileGeneratedSchema };
