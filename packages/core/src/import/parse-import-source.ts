import { createHash } from 'node:crypto';

import type { JsonValue } from '@attest/contracts';

import { decodeSource } from './decode-source.js';
import { importDiagnostic } from './import-diagnostics.js';
import type {
  ImportDiagnostic,
  ImportFormat,
  ImportLimits,
  ImportLocation,
  ParsedRecords,
  SourceRecord,
} from './import-types.js';
import { resolveJsonPointer } from './json-pointer.js';
import { parseCsvSource } from './parse-csv.js';

interface ParsedImportSource extends ParsedRecords {
  sourceHash: string;
}

interface ParseImportSourceOptions {
  limits?: Partial<ImportLimits>;
  recordsPointer?: string;
}

const DEFAULT_IMPORT_LIMITS: ImportLimits = { maxBytes: 10 * 1024 * 1024, maxRows: 100_000 };

const fail = (diagnostic: ImportDiagnostic): ParsedRecords => ({
  diagnostics: [diagnostic],
  records: [],
  rowsSeen: 0,
});

const objectRecord = (
  value: JsonValue,
  location: ImportLocation,
  diagnostics: ImportDiagnostic[],
): SourceRecord | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push(
      importDiagnostic({
        code: 'record_not_object',
        message: 'Each imported record must be a JSON object.',
        hint: 'Wrap mapped fields in an object.',
        location,
      }),
    );
    return undefined;
  }
  return { ...location, value };
};

const parseJsonSource = (
  text: string,
  recordsPointer: string | undefined,
  maxRows: number,
): ParsedRecords => {
  let document: JsonValue;
  try {
    document = JSON.parse(text) as JsonValue;
  } catch {
    return fail(
      importDiagnostic({
        code: 'invalid_json',
        message: 'Import source is not valid JSON.',
        hint: 'Provide a complete JSON array or repair the malformed document.',
      }),
    );
  }
  const selected = resolveJsonPointer(document, recordsPointer ?? '');
  if (!selected.found) {
    return fail(
      importDiagnostic({
        code: 'records_pointer_missing',
        message: 'The records pointer does not resolve in the JSON document.',
        hint: 'Pass an RFC 6901 pointer to the array of records.',
      }),
    );
  }
  if (!Array.isArray(selected.value)) {
    return fail(
      importDiagnostic({
        code: 'records_not_array',
        message: 'The selected JSON records value is not an array.',
        hint: 'Use a top-level array or point --records-pointer at an array.',
      }),
    );
  }
  const diagnostics: ImportDiagnostic[] = [];
  const records: SourceRecord[] = [];
  for (const [index, value] of selected.value.slice(0, maxRows).entries()) {
    const record = objectRecord(value, { row: index + 1 }, diagnostics);
    if (record !== undefined) records.push(record);
  }
  return { diagnostics, records, rowsSeen: selected.value.length };
};

const parseJsonlSource = (text: string, maxRows: number): ParsedRecords => {
  const diagnostics: ImportDiagnostic[] = [];
  const records: SourceRecord[] = [];
  let rowsSeen = 0;
  for (const [index, rawLine] of text.split('\n').entries()) {
    const line = rawLine.replace(/\r$/u, '');
    if (line.trim().length === 0) continue;
    rowsSeen += 1;
    if (rowsSeen > maxRows) break;
    const location = { line: index + 1 };
    let value: JsonValue;
    try {
      value = JSON.parse(line) as JsonValue;
    } catch {
      diagnostics.push(
        importDiagnostic({
          code: 'invalid_json',
          message: 'Line is not valid JSON.',
          hint: 'Provide exactly one JSON object on this nonblank line.',
          sourceField: '<line>',
          location,
        }),
      );
      continue;
    }
    const record = objectRecord(value, location, diagnostics);
    if (record !== undefined) records.push(record);
  }
  return { diagnostics, records, rowsSeen };
};

const parseRecords = (
  text: string,
  format: ImportFormat,
  recordsPointer: string | undefined,
  maxRows: number,
): ParsedRecords => {
  switch (format) {
    case 'csv':
      return parseCsvSource(text, maxRows);
    case 'json':
      return parseJsonSource(text, recordsPointer, maxRows);
    case 'jsonl':
      return parseJsonlSource(text, maxRows);
  }
};

/** Decodes and parses the complete bounded source before normalization or reconciliation begins. */
const parseImportSource = (
  source: string | Uint8Array,
  format: ImportFormat,
  options: ParseImportSourceOptions = {},
): ParsedImportSource => {
  const limits = { ...DEFAULT_IMPORT_LIMITS, ...options.limits };
  const decoded = decodeSource(source);
  const sourceHash = createHash('sha256').update(decoded.bytes).digest('hex');
  if (decoded.bytes.byteLength > limits.maxBytes) {
    const diagnostic = importDiagnostic({
      code: 'import_size_limit',
      message: `Import source exceeds the ${limits.maxBytes}-byte limit.`,
      hint: 'Split the source into smaller explicit imports.',
    });
    return { ...fail(diagnostic), sourceHash };
  }
  if (decoded.diagnostics.length > 0) {
    return { diagnostics: decoded.diagnostics, records: [], rowsSeen: 0, sourceHash };
  }
  const parsed = parseRecords(decoded.text, format, options.recordsPointer, limits.maxRows);
  if (parsed.rowsSeen > limits.maxRows) {
    parsed.diagnostics.push(
      importDiagnostic({
        code: 'import_row_limit',
        message: `Import source exceeds the ${limits.maxRows}-row limit.`,
        hint: 'Split the source into smaller explicit imports.',
      }),
    );
  }
  return {
    diagnostics: parsed.diagnostics,
    records: parsed.records.slice(0, limits.maxRows),
    rowsSeen: parsed.rowsSeen,
    sourceHash,
  };
};

export { DEFAULT_IMPORT_LIMITS, parseImportSource };
