import { decodeSource } from './decode-source.js';
import { importDiagnostic } from './import-diagnostics.js';
import {
  TabularImportError,
  type ImportDiagnostic,
  type ParsedRecords,
  type SourceRecord,
} from './import-types.js';

interface CsvRecord {
  fields: string[];
  line: number;
}

const malformedCsv = (message: string, hint: string, line: number): ImportDiagnostic =>
  importDiagnostic({ code: 'malformed_csv', message, hint, location: { line } });

/** Parses RFC 4180-style quoting, escaped quotes, CRLF, and quoted newlines deterministically. */
const parseCsvRecords = (
  text: string,
  maxRecords: number,
): { diagnostics: ImportDiagnostic[]; records: CsvRecord[] } => {
  const diagnostics: ImportDiagnostic[] = [];
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let line = 1;
  let recordLine = 1;
  let quoted = false;
  let closedQuote = false;

  const finishRecord = (): void => {
    fields.push(field);
    records.push({ fields, line: recordLine });
    fields = [];
    field = '';
    recordLine = line + 1;
    closedQuote = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
        closedQuote = true;
      } else {
        field += character;
        if (character === '\n') line += 1;
      }
      continue;
    }
    if (closedQuote && character !== ',' && character !== '\n' && character !== '\r') {
      diagnostics.push(
        malformedCsv(
          'Unexpected character after a closing CSV quote.',
          'Follow a closing quote with a delimiter, newline, or end of input.',
          line,
        ),
      );
      closedQuote = false;
    }
    if (character === '"' && !closedQuote) {
      if (field.length === 0) {
        quoted = true;
      } else {
        diagnostics.push(
          malformedCsv(
            'A CSV quote cannot begin inside an unquoted field.',
            'Quote the complete field and escape embedded quotes by doubling them.',
            line,
          ),
        );
      }
    } else if (character === ',') {
      fields.push(field);
      field = '';
      closedQuote = false;
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      finishRecord();
      if (records.length >= maxRecords) break;
      line += 1;
      recordLine = line;
    } else if (!closedQuote) {
      field += character;
    }
  }
  if (quoted) {
    diagnostics.push(
      malformedCsv(
        'CSV input ends inside a quoted field.',
        'Close the quoted field before end of input.',
        recordLine,
      ),
    );
  }
  if (field.length > 0 || fields.length > 0 || (text.length > 0 && !/[\r\n]$/u.test(text))) {
    fields.push(field);
    records.push({ fields, line: recordLine });
  }
  return { diagnostics, records };
};

const duplicateHeaderDiagnostics = (headerRecord: CsvRecord): ImportDiagnostic[] => {
  const diagnostics: ImportDiagnostic[] = [];
  const seenHeaders = new Set<string>();
  for (const [index, header] of headerRecord.fields.entries()) {
    if (seenHeaders.has(header)) {
      diagnostics.push(
        importDiagnostic({
          code: 'duplicate_csv_header',
          message: `CSV header ${header || '<empty>'} is duplicated.`,
          hint: 'Rename every CSV header so it is unique.',
          sourceField: header || `<column-${index + 1}>`,
          location: { line: headerRecord.line },
        }),
      );
    }
    seenHeaders.add(header);
  }
  return diagnostics;
};

/** Parses a CSV source into header-keyed records, reading at most one row past `maxRows`. */
const parseCsvSource = (text: string, maxRows: number): ParsedRecords => {
  // The header plus one row beyond the limit is enough to report the overflow.
  const parsed = parseCsvRecords(text, maxRows + 2);
  const diagnostics = [...parsed.diagnostics];
  const [headerRecord, ...dataRecords] = parsed.records;
  if (headerRecord === undefined) {
    diagnostics.push(
      importDiagnostic({
        code: 'csv_header_missing',
        message: 'CSV input has no header row.',
        hint: 'Provide one unique header row.',
      }),
    );
    return { diagnostics, records: [], rowsSeen: 0 };
  }
  const headers = headerRecord.fields;
  diagnostics.push(...duplicateHeaderDiagnostics(headerRecord));
  const records: SourceRecord[] = [];
  for (const { fields, line } of dataRecords) {
    // Ignore a physically blank trailing/data row, but retain authored empty comma-delimited rows.
    if (fields.length === 1 && fields[0] === '') continue;
    if (fields.length !== headers.length) {
      diagnostics.push(
        importDiagnostic({
          code: 'csv_column_count',
          message: `CSV row has ${fields.length} fields but the header has ${headers.length}.`,
          hint: 'Add or remove delimiters so every row matches the header width.',
          location: { row: line },
        }),
      );
    }
    records.push({
      row: line,
      value: Object.fromEntries(headers.map((header, index) => [header, fields[index] ?? ''])),
    });
  }
  return { diagnostics, records, rowsSeen: dataRecords.length };
};

/**
 * Reads only the CSV header, with the same UTF-8 and quoting checks as a full import, so a guided
 * import can offer mapping choices before the user commits to one.
 */
const discoverCsvHeaders = (source: Uint8Array): string[] => {
  const decoded = decodeSource(source);
  if (decoded.diagnostics.length > 0) {
    throw new TabularImportError('Import source validation failed.', decoded.diagnostics);
  }
  const parsed = parseCsvRecords(decoded.text, 1);
  if (parsed.diagnostics.length > 0) {
    throw new TabularImportError('Import source validation failed.', parsed.diagnostics);
  }
  return parsed.records[0]?.fields ?? [];
};

export { discoverCsvHeaders, parseCsvSource };
