import type { JsonValue } from '@attest/contracts';
import { z } from 'zod';

const jsonValueSchema = z.json();

/** Narrows parsed data to JSON, rejecting the non-finite numbers JSON.parse can produce from exponents. */
const isJsonValue = (value: unknown): value is JsonValue =>
  jsonValueSchema.safeParse(value).success;

export { isJsonValue };
