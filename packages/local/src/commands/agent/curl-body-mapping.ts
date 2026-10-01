import type { JsonValue } from '@attest/contracts';

import { parseJsonPointer } from '../../internal/json-pointer.js';
import { isSensitiveFieldName } from '../../internal/redaction.js';
import { CurlImportError } from './curl-tokenizer.js';

type CurlPlaceholderMapping = { inputPointer: string; targetPointer: string };

/** Rejects credential-shaped JSON fields because body secret resolution is intentionally unsupported. */
const assertNoSensitiveBodyFields = (value: JsonValue): void => {
  if (Array.isArray(value)) {
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
const applyPlaceholder = (body: JsonValue, mapping: CurlPlaceholderMapping): void => {
  if (!/^(?:\/(?:[^~/]|~[01])*)*$/u.test(mapping.targetPointer) || mapping.targetPointer === '') {
    throw new CurlImportError('A cURL body mapping target is invalid.', ['invalid_target_pointer']);
  }
  if (!/^(?:\/(?:[^~/]|~[01])*)*$/u.test(mapping.inputPointer)) {
    throw new CurlImportError('A cURL input mapping pointer is invalid.', [
      'invalid_input_pointer',
    ]);
  }
  const tokens = parseJsonPointer(mapping.targetPointer) ?? [];
  const final = tokens.pop()!;
  let parent: JsonValue = body;
  for (const token of tokens) {
    if (Array.isArray(parent) && /^(?:0|[1-9]\d*)$/u.test(token)) parent = parent[Number(token)]!;
    else if (
      parent !== null &&
      typeof parent === 'object' &&
      !Array.isArray(parent) &&
      Object.hasOwn(parent, token)
    ) {
      parent = (parent as Record<string, JsonValue>)[token]!;
    } else {
      throw new CurlImportError('A cURL body mapping target does not exist.', [
        'missing_target_pointer',
      ]);
    }
  }
  const placeholder = `{{input${mapping.inputPointer}}}`;
  if (Array.isArray(parent) && /^(?:0|[1-9]\d*)$/u.test(final) && Number(final) < parent.length) {
    parent[Number(final)] = placeholder;
  } else if (
    parent !== null &&
    typeof parent === 'object' &&
    !Array.isArray(parent) &&
    Object.hasOwn(parent, final)
  ) {
    (parent as Record<string, JsonValue>)[final] = placeholder;
  } else {
    throw new CurlImportError('A cURL body mapping target does not exist.', [
      'missing_target_pointer',
    ]);
  }
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
