import type { TestCase } from '@attest/contracts';

import type { ImportDiagnostic, ImportLocation } from './import-types.js';

type NormalizedImportRow = {
  case: TestCase;
  contentFingerprint: string;
  explicitId: boolean;
  generatedFromContent: boolean;
  identitySource: 'content' | 'id' | 'key';
  location: ImportLocation;
  sourceKeyFingerprint?: string;
};

/** Creates one stable diagnostic shared by mapping and reconciliation. */
const createImportDiagnostic = (
  code: string,
  message: string,
  hint: string,
  sourceField: string,
  destinationPath: string,
  location: ImportLocation = {},
): ImportDiagnostic => ({
  code,
  destination_path: destinationPath,
  hint,
  message,
  source_field: sourceField,
  ...location,
});

/** Orders import diagnostics by source position and destination. */
const sortImportDiagnostics = (diagnostics: readonly ImportDiagnostic[]): ImportDiagnostic[] =>
  [...diagnostics].sort(
    (left, right) =>
      (left.line ?? left.row ?? 0) - (right.line ?? right.row ?? 0) ||
      left.source_field.localeCompare(right.source_field, 'en') ||
      left.destination_path.localeCompare(right.destination_path, 'en') ||
      left.code.localeCompare(right.code, 'en'),
  );

export { createImportDiagnostic, sortImportDiagnostics, type NormalizedImportRow };
