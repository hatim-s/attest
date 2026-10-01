import type { ImportDiagnostic, ImportDiagnosticCode, ImportLocation } from './import-types.js';

interface ImportDiagnosticOptions {
  code: ImportDiagnosticCode;
  message: string;
  hint: string;
  /** Authored source field or placeholder such as `<record>`; never an authored value. */
  sourceField?: string;
  destinationPath?: string;
  location?: ImportLocation;
}

/** Copies only public physical coordinates so authored row values can never leak. */
const importLocation = (location: ImportLocation): ImportLocation => {
  const copied: ImportLocation = {};
  if (location.line !== undefined) copied.line = location.line;
  if (location.row !== undefined) copied.row = location.row;
  return copied;
};

/** Builds a diagnostic; whole-record problems default to `<record>` with no destination. */
const importDiagnostic = ({
  code,
  message,
  hint,
  sourceField = '<record>',
  destinationPath = '',
  location = {},
}: ImportDiagnosticOptions): ImportDiagnostic => ({
  code,
  destination_path: destinationPath,
  hint,
  message,
  source_field: sourceField,
  ...importLocation(location),
});

/** Orders diagnostics by source position and destination so reports are stable across runs. */
const sortImportDiagnostics = (diagnostics: readonly ImportDiagnostic[]): ImportDiagnostic[] =>
  diagnostics.toSorted(
    (left, right) =>
      (left.line ?? left.row ?? 0) - (right.line ?? right.row ?? 0) ||
      left.source_field.localeCompare(right.source_field, 'en') ||
      left.destination_path.localeCompare(right.destination_path, 'en') ||
      left.code.localeCompare(right.code, 'en'),
  );

export { importDiagnostic, importLocation, sortImportDiagnostics };
