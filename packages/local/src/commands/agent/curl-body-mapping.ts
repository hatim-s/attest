import { isJsonArray } from '../../internal/json-array.js';
import { isJsonObject, type JsonValue } from '@attest/contracts';

import { parseJsonPointer } from '../../internal/json-pointer.js';
import { isSensitiveFieldName } from '../../internal/redaction.js';
import { CurlImportError } from './curl-tokenizer.js';

type CurlPlaceholderMapping = { inputPointer: string; targetPointer: string };

/** Rejects credential-shaped JSON fields because body secret resolution is intentionally unsupported. */
// BOUNDARY: Imported curl JSON bodies are checked recursively for sensitive field names before they become project resources.
const assertNoSensitiveBodyFields = (value: JsonValue): void => {
  if (isJsonArray(value)) {
    for (const entry of value) assertNoSensitiveBodyFields(entry);

    return;
  }

  if (value === null || typeof value !== 'object') return;

  for (const [name, entry] of Object.entries(value)) {
    if (isSensitiveFieldName(name)) {
      throw new CurlImportError('The cURL body contains an unsafe credential field.', [
        `unsafe_body_field:${name.toLowerCase()}`,
      ]);
    }

    assertNoSensitiveBodyFields(entry);
  }
};

/** Replaces one existing JSON target with a typed input placeholder and never creates guessed paths. */
// BOUNDARY: CLI placeholder mappings address imported curl JSON; validate pointer syntax and own-container paths before writing.
const applyPlaceholder = (body: JsonValue, mapping: CurlPlaceholderMapping): JsonValue => {
  const tokens = parseJsonPointer(mapping.targetPointer);

  if (tokens === undefined || tokens.length === 0) {
    throw new CurlImportError('A cURL body mapping target is invalid.', ['invalid_target_pointer']);
  }

  if (parseJsonPointer(mapping.inputPointer) === undefined) {
    throw new CurlImportError('A cURL input mapping pointer is invalid.', [
      'invalid_input_pointer',
    ]);
  }

  const replace = (value: JsonValue, depth: number): JsonValue => {
    if (depth === tokens.length) return `{{input${mapping.inputPointer}}}`;
    const token = tokens[depth]!;

    if (isJsonArray(value) && /^(?:0|[1-9]\d*)$/u.test(token) && Number(token) < value.length) {
      return value.map((entry, index) =>
        index === Number(token) ? replace(entry, depth + 1) : entry,
      );
    }

    if (isJsonObject(value) && Object.hasOwn(value, token)) {
      return { ...value, [token]: replace(value[token]!, depth + 1) };
    }

    throw new CurlImportError('A cURL body mapping target does not exist.', [
      'missing_target_pointer',
    ]);
  };

  return replace(body, 0);
};

/** Applies pointer-shaped mappings to unique form fields while preserving form wire encoding. */
const mapFormBody = (body: string, mappings: readonly CurlPlaceholderMapping[]): string => {
  const form = new URLSearchParams(body);

  for (const name of form.keys()) {
    if (isSensitiveFieldName(name)) {
      throw new CurlImportError('The cURL form body contains an unsafe credential field.', [
        `unsafe_body_field:${name.toLowerCase()}`,
      ]);
    }
  }

  if (mappings.length === 0) return body;

  for (const mapping of mappings) {
    const tokens = parseJsonPointer(mapping.targetPointer) ?? [];

    if (tokens.length !== 1 || !form.has(tokens[0]!) || form.getAll(tokens[0]!).length !== 1) {
      throw new CurlImportError('A form body mapping target is missing or ambiguous.', [
        'invalid_form_target',
      ]);
    }

    form.set(tokens[0]!, `{{input${mapping.inputPointer}}}`);
  }

  return mappings.reduce((serialized, mapping) => {
    const placeholder = `{{input${mapping.inputPointer}}}`;

    return serialized.replaceAll(encodeURIComponent(placeholder), placeholder);
  }, form.toString());
};

export { applyPlaceholder, assertNoSensitiveBodyFields, mapFormBody, type CurlPlaceholderMapping };
