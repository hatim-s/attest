import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import type { LeafAssertionCheck } from '@attest/contracts';

import type { PathResolution } from '../evaluation-document.js';
import { AttestMetricError } from '../errors.js';
import { pathNotFound } from './path.js';

type CheckEvaluation = { passed: boolean; reason?: string };
type JsonSchemaCheck = Extract<LeafAssertionCheck, { json_schema: unknown }>['json_schema'];

type SchemaValidator = {
  validate: ValidateFunction;
  formatErrors: (errors: ValidateFunction['errors']) => string;
};

// Config validation freezes metric definitions before evaluation, so object identity is a safe cache key.
// Keep this cache here: compiling schemas is the only stateful assertion concern.
const objectSchemaValidators = new WeakMap<object, SchemaValidator>();

/** Compiles one root schema in an isolated Ajv registry so independent `$id` values cannot collide. */
const compileSchemaValidator = (schema: JsonSchemaCheck['schema']): SchemaValidator => {
  const ajv = new Ajv2020.Ajv2020({ allErrors: true, strict: false });
  try {
    const validate = ajv.compile(schema);
    return {
      validate,
      formatErrors: (errors) => ajv.errorsText(errors, { separator: '; ' }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AttestMetricError(
      'invalid_json_schema',
      `JSON Schema could not be compiled: ${message}`,
      {
        cause: error,
      },
    );
  }
};

const getSchemaValidator = (schema: JsonSchemaCheck['schema']): SchemaValidator => {
  if (typeof schema === 'boolean') {
    // Boolean schemas are trivial; compiling per evaluation avoids a separate mutable cache for two values.
    return compileSchemaValidator(schema);
  }

  const cached = objectSchemaValidators.get(schema);
  if (cached !== undefined) {
    return cached;
  }
  const validator = compileSchemaValidator(schema);
  objectSchemaValidators.set(schema, validator);
  return validator;
};

/** Validates a resolved value with Draft 2020-12 while schema mistakes remain typed metric errors. */
const evaluateJsonSchemaCheck = (
  check: JsonSchemaCheck,
  resolution: PathResolution,
): CheckEvaluation => {
  if (!resolution.found) {
    return pathNotFound(check.path);
  }

  const validator = getSchemaValidator(check.schema);
  if ('$async' in validator.validate && validator.validate.$async === true) {
    return { passed: false, reason: `JSON Schema at ${check.path} must be synchronous` };
  }
  if (validator.validate(resolution.value)) {
    return { passed: true };
  }
  return {
    passed: false,
    reason: `value at ${check.path} failed JSON Schema validation: ${validator.formatErrors(validator.validate.errors)}`,
  };
};

export { evaluateJsonSchemaCheck };
