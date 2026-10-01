import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';

import type { PathResolution } from '../evaluation-document.js';
import { AttestMetricError } from '../errors.js';
import type { CheckEvaluation, LeafCheck } from './leaf-check.js';
import { pathNotFound } from './path.js';

type JsonSchemaCheck = LeafCheck<'json_schema'>;

type SchemaValidator = {
  validate: ValidateFunction;
  formatErrors: (errors: ValidateFunction['errors']) => string;
};

// Config validation freezes metric definitions before evaluation, so object identity is a safe cache key.
const schemaValidators = new WeakMap<object, SchemaValidator>();

/** Compiles one root schema in an isolated Ajv registry so independent `$id` values cannot collide. */
const compileSchemaValidator = (schema: object): SchemaValidator => {
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

/** Returns the cached validator for a schema object, compiling it on first use. */
const getSchemaValidator = (schema: object): SchemaValidator => {
  const cached = schemaValidators.get(schema);
  if (cached !== undefined) {
    return cached;
  }
  const validator = compileSchemaValidator(schema);
  schemaValidators.set(schema, validator);
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
  // Boolean schemas accept or reject everything, so they never need Ajv.
  if (typeof check.schema === 'boolean') {
    return check.schema
      ? { passed: true }
      : {
          passed: false,
          reason: `value at ${check.path} failed JSON Schema validation: boolean schema is false`,
        };
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
