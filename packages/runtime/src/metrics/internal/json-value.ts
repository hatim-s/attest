import { parseWithSchema } from '@attest/contracts';
import type { JsonValue } from '@attest/contracts';
import * as Schema from 'effect/Schema';

const jsonValueSchema = Schema.Json;

/** Narrows parsed data to JSON, rejecting the non-finite numbers JSON.parse can produce from exponents. */
const isJsonValue = (value: unknown): value is JsonValue =>
  parseWithSchema(jsonValueSchema, value).ok;

export { isJsonValue };
