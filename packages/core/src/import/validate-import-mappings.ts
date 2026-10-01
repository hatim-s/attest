import type { DatasetImportMapping } from '@attest/contracts';

import { importDiagnostic } from './import-diagnostics.js';
import type { ImportDiagnostic, ImportFormat } from './import-types.js';
import { toPointer } from './json-pointer.js';

/** Path segments that could reach an object prototype when assigned. */
const UNSAFE_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/** Splits dotted destinations while allowing literal dots and backslashes to be escaped. */
const splitDestination = (destination: string): string[] => {
  const segments: string[] = [];
  let segment = '';
  let escaping = false;
  for (const character of destination) {
    if (escaping) {
      segment += character;
      escaping = false;
    } else if (character === '\\') {
      escaping = true;
    } else if (character === '.') {
      segments.push(segment);
      segment = '';
    } else {
      segment += character;
    }
  }
  if (escaping) segment += '\\';
  segments.push(segment);
  return segments;
};

const destinationPointer = (destination: string): string =>
  toPointer(splitDestination(destination));

/** Two destinations overlap when one is a prefix of the other, such as `input` and `input.a`. */
const overlaps = (left: readonly string[], right: readonly string[]): boolean => {
  const common = Math.min(left.length, right.length);
  return left.slice(0, common).every((segment, index) => segment === right[index]);
};

/**
 * Checks mappings before any record is read: unsafe or overlapping destinations would make
 * assignment ambiguous or unsafe, so these must reject the whole import.
 */
const assertMappingShape = (
  format: ImportFormat,
  mappings: readonly DatasetImportMapping[],
): ImportDiagnostic[] => {
  const diagnostics: ImportDiagnostic[] = [];
  if (format === 'csv' && mappings.length === 0) {
    diagnostics.push(
      importDiagnostic({
        code: 'mapping_required',
        message: 'CSV imports require at least one explicit field mapping.',
        hint: 'Pass --map input=<header> and any other required mappings.',
        sourceField: '<mapping>',
      }),
    );
  }
  const destinations = mappings.map(({ destination }) => splitDestination(destination));
  for (const [index, { source }] of mappings.entries()) {
    const path = destinations[index]!;
    const destinationPath = toPointer(path);
    if (path.some((segment) => UNSAFE_SEGMENTS.has(segment))) {
      diagnostics.push(
        importDiagnostic({
          code: 'mapping_destination_unsafe',
          message: 'Mapping destinations cannot contain prototype-mutating path segments.',
          hint: 'Rename the destination field to a plain data key.',
          sourceField: source,
          destinationPath,
        }),
      );
    }
    if (path[0] === 'metrics') {
      diagnostics.push(
        importDiagnostic({
          code: 'mapping_destination_renamed',
          message: 'The metrics destination is named metric_overrides.',
          hint: 'Map the source to metric_overrides with { metric_id } objects.',
          sourceField: source,
          destinationPath,
        }),
      );
    }
    for (const [priorIndex, prior] of destinations.slice(0, index).entries()) {
      if (!overlaps(path, prior)) continue;
      diagnostics.push(
        importDiagnostic({
          code: 'mapping_destination_conflict',
          message: `Mappings ${priorIndex + 1} and ${index + 1} target overlapping destinations.`,
          hint: 'Map either a whole value or its nested fields, not both.',
          sourceField: source,
          destinationPath,
        }),
      );
    }
    if (format !== 'csv' && !source.startsWith('/')) {
      diagnostics.push(
        importDiagnostic({
          code: 'source_pointer_required',
          message: 'JSON and JSONL mapping sources must be RFC 6901 pointers.',
          hint: 'Prefix the source with `/` and escape `~` or `/` pointer segments.',
          sourceField: source,
          destinationPath,
        }),
      );
    }
  }
  return diagnostics;
};

export { assertMappingShape, destinationPointer, splitDestination };
