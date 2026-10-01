import { dedupeImportRows } from './dedupe-import-rows.js';
import { importDiagnostic, sortImportDiagnostics } from './import-diagnostics.js';
import {
  TabularImportError,
  type ImportDiagnostic,
  type NormalizedImportRow,
  type RedactedValue,
  type TabularImportRequest,
  type TabularImportResult,
} from './import-types.js';
import { normalizeRecord } from './map-import-record.js';
import { parseImportSource } from './parse-import-source.js';
import { reconcileRows } from './reconcile-import.js';
import { assertMappingShape } from './validate-import-mappings.js';

const PREVIEW_ROWS = 5;

const redactFields = (record: object): Record<string, RedactedValue> =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, redactValue(value)]));

const redactValue = (value: unknown): RedactedValue => {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === 'object') return redactFields(value);
  return `<redacted:${typeof value}>`;
};

const createImportPreview = (
  rows: readonly NormalizedImportRow[],
): TabularImportResult['preview'] =>
  rows.slice(0, PREVIEW_ROWS).map(({ case: { id, ...content } }) => ({
    id,
    ...redactFields(content),
  }));

/** Option combinations that only apply to one format, checked before any record is mapped. */
const requestDiagnostics = (request: TabularImportRequest): ImportDiagnostic[] => {
  const diagnostics = assertMappingShape(request.format, request.mappings ?? []);
  if (request.recordsPointer !== undefined && request.format !== 'json') {
    diagnostics.push(
      importDiagnostic({
        code: 'records_pointer_format',
        message: 'A records pointer is supported only for JSON imports.',
        hint: 'Remove --records-pointer or select --format json.',
        sourceField: '<records-pointer>',
      }),
    );
  }
  if ((request.parseJsonSources?.length ?? 0) > 0 && request.format !== 'csv') {
    diagnostics.push(
      importDiagnostic({
        code: 'parse_json_format',
        message: '--parse-json is supported only for CSV columns.',
        hint: 'Remove --parse-json or select --format csv.',
        sourceField: '<parse-json>',
      }),
    );
  }
  return diagnostics;
};

const failValidation = (diagnostics: readonly ImportDiagnostic[]): never => {
  throw new TabularImportError(
    'Imported case validation failed.',
    sortImportDiagnostics(diagnostics),
  );
};

/**
 * Parses, maps, validates, deduplicates, and reconciles a bounded import in memory. It is
 * all-or-nothing: any diagnostic throws `TabularImportError` with every problem found, and the
 * caller writes nothing.
 */
const importTabularCases = (request: TabularImportRequest): TabularImportResult => {
  const parsed = parseImportSource(request.source, request.format, {
    limits: request.limits,
    recordsPointer: request.recordsPointer,
  });
  const diagnostics = [...parsed.diagnostics, ...requestDiagnostics(request)];
  // Invalid mappings would misplace every record, so row-level checks would only add noise.
  if (diagnostics.length > parsed.diagnostics.length) failValidation(diagnostics);

  const rows: NormalizedImportRow[] = [];
  for (const record of parsed.records) {
    const normalized = normalizeRecord(record, request);
    diagnostics.push(...normalized.diagnostics);
    if (normalized.row !== undefined) rows.push(normalized.row);
  }
  const deduped = dedupeImportRows(rows, request);
  diagnostics.push(...deduped.diagnostics);
  if (diagnostics.length > 0) failValidation(diagnostics);

  return {
    ...reconcileRows(deduped, request),
    format: request.format,
    preview: createImportPreview(deduped.rows),
    sourceHash: parsed.sourceHash,
  };
};

export { importTabularCases };
