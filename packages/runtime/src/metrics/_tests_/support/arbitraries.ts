import type { JsonValue } from '@attest/contracts';
import fc from 'fast-check';

import type { EvaluationDocument } from '../../evaluation-document.js';
import { isJsonValue } from '../../internal/json-value.js';

const toJsonValue = (value: unknown): JsonValue => {
  if (!isJsonValue(value)) {
    throw new Error('fast-check generated a non-JSON value');
  }
  return value;
};

const jsonValueArbitrary: fc.Arbitrary<JsonValue> = fc.jsonValue().map(toJsonValue);

/** Documents whose optional output and expected fields are sometimes absent, never undefined. */
const generatedDocumentArbitrary: fc.Arbitrary<EvaluationDocument> = fc.record(
  {
    input: jsonValueArbitrary,
    output: jsonValueArbitrary,
    expected: jsonValueArbitrary,
    trace: fc.constant(null),
  },
  { requiredKeys: ['input', 'trace'] },
);

export { generatedDocumentArbitrary, jsonValueArbitrary };
