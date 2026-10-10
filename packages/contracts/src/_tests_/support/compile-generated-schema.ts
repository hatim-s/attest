import { z } from 'zod';
import * as formatsModule from 'ajv-formats';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';

import { serializeContractSchema } from '../../schema/json-schema.js';

const ajv = new Ajv2020({ allErrors: true, strict: false });

formatsModule.default.default(ajv);

// Same alphabet as z.ulid(): Crockford base32, either case.
ajv.addFormat('ulid', /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/u);

const validators = new Map<string, ValidateFunction>();

/** Compiles the serializer output for one published schema file, so tests check what ships. */
const compileGeneratedSchema = (fileName: string): ValidateFunction => {
  const cached = validators.get(fileName);

  if (cached !== undefined) {
    return cached;
  }

  const validator = ajv.compile(
    z.record(z.string(), z.json()).parse(JSON.parse(serializeContractSchema(fileName))),
  );

  validators.set(fileName, validator);

  return validator;
};

export { compileGeneratedSchema };
