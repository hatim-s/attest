import { createHash } from 'node:crypto';

import type {
  ImportDiagnostic,
  ImportFormat,
  ImportLimits,
  ImportLocation,
} from './import-types.js';
import { TabularImportError } from './import-types.js';

type SourceRecord = ImportLocation & { value: Record<string, unknown> };
type ParsedImportSource = {
  diagnostics: ImportDiagnostic[];
  records: SourceRecord[];
  rowsSeen: number;
  sourceHash: string;
};

const DEFAULT_IMPORT_LIMITS: ImportLimits = { maxBytes: 10 * 1024 * 1024, maxRows: 100_000 };

const diagnostic = (
  code: string,
  message: string,
  hint: string,
  location: ImportLocation = {},
): ImportDiagnostic => ({
  code,
  destination_path: '',
  hint,
  message,
  source_field: '<record>',
  ...location,
});

/** Collects an import stream with a hard byte ceiling before returning any materialized source. */
const collectBoundedImportSource = async (
  chunks: AsyncIterable<string | Uint8Array>,
  maxBytes = DEFAULT_IMPORT_LIMITS.maxBytes,
): Promise<Uint8Array> => {
  const collected: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of chunks) {
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
    byteLength += bytes.byteLength;
    if (byteLength > maxBytes) {
      throw new TabularImportError('Import source validation failed.', [
        diagnostic(
          'import_size_limit',
          `Import source exceeds the ${maxBytes}-byte limit.`,
          'Split the source into smaller explicit imports.',
        ),
      ]);
    }
    collected.push(bytes);
  }
  const source = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of collected) {
    source.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return source;
};

/** Resolves an RFC 6901 pointer without interpreting dotted object keys. */
const resolveJsonPointer = (
  value: unknown,
  pointer: string,
): { found: boolean; value?: unknown } => {
  if (pointer === '') return { found: true, value };
  if (!pointer.startsWith('/')) return { found: false };
  let current = value;
  for (const encoded of pointer.slice(1).split('/')) {
    const segment = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(segment)) return { found: false };
      const index = Number(segment);
      if (index >= current.length) return { found: false };
      current = current[index];
    } else if (current !== null && typeof current === 'object') {
      if (!Object.hasOwn(current, segment)) return { found: false };
      current = (current as Record<string, unknown>)[segment];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
};

const decodeSource = (
  source: string | Uint8Array,
): { bytes: Uint8Array; diagnostics: ImportDiagnostic[]; text: string } => {
  const bytes = typeof source === 'string' ? new TextEncoder().encode(source) : source;
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return {
      bytes,
      diagnostics: [],
      text: decoded.startsWith('\uFEFF') ? decoded.slice(1) : decoded,
    };
  } catch {
    return {
      bytes,
      diagnostics: [
        diagnostic(
          'invalid_utf8',
          'Import source is not valid UTF-8.',
          'Re-encode the complete source as UTF-8 and retry.',
        ),
      ],
      text: '',
    };
  }
};

const objectRecord = (
  value: unknown,
  location: ImportLocation,
  diagnostics: ImportDiagnostic[],
): SourceRecord | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push(
      diagnostic(
        'record_not_object',
        'Each imported record must be a JSON object.',
        'Wrap mapped fields in an object.',
        location,
      ),
    );
    return undefined;
  }
  return { ...location, value: value as Record<string, unknown> };
};

const parseJsonSource = (
  text: string,
  recordsPointer: string | undefined,
  maxRows: number,
): Pick<ParsedImportSource, 'diagnostics' | 'records' | 'rowsSeen'> => {
  const diagnostics: ImportDiagnostic[] = [];
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch {
    return {
      diagnostics: [
        diagnostic(
          'invalid_json',
          'Import source is not valid JSON.',
          'Provide a complete JSON array or repair the malformed document.',
        ),
      ],
      records: [],
      rowsSeen: 0,
    };
  }
  const selected =
    recordsPointer === undefined
      ? { found: true, value: document }
      : resolveJsonPointer(document, recordsPointer);
  if (!selected.found) {
    return {
      diagnostics: [
        diagnostic(
          'records_pointer_missing',
          'The records pointer does not resolve in the JSON document.',
          'Pass an RFC 6901 pointer to the array of records.',
        ),
      ],
      records: [],
      rowsSeen: 0,
    };
  }
  if (!Array.isArray(selected.value)) {
    return {
      diagnostics: [
        diagnostic(
          'records_not_array',
          'The selected JSON records value is not an array.',
          'Use a top-level array or point --records-pointer at an array.',
        ),
      ],
      records: [],
      rowsSeen: 0,
    };
  }
  const records = selected.value.slice(0, maxRows).flatMap((value, index) => {
    const record = objectRecord(value, { row: index + 1 }, diagnostics);
    return record === undefined ? [] : [record];
  });
  return { diagnostics, records, rowsSeen: selected.value.length };
};

const parseJsonlSource = (
  text: string,
  maxRows: number,
): Pick<ParsedImportSource, 'diagnostics' | 'records' | 'rowsSeen'> => {
  const diagnostics: ImportDiagnostic[] = [];
  const records: SourceRecord[] = [];
  let rowsSeen = 0;
  let lineNumber = 1;
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline < 0 ? text.length : newline;
    const line = text.slice(start, end).replace(/\r$/u, '');
    if (line.trim().length > 0) {
      rowsSeen += 1;
      if (rowsSeen > maxRows) break;
      try {
        const record = objectRecord(JSON.parse(line) as unknown, { line: lineNumber }, diagnostics);
        if (record !== undefined) records.push(record);
      } catch {
        diagnostics.push({
          ...diagnostic(
            'invalid_json',
            'Line is not valid JSON.',
            'Provide exactly one JSON object on this nonblank line.',
            { line: lineNumber },
          ),
          source_field: '<line>',
        });
      }
    }
    if (newline < 0) break;
    start = newline + 1;
    lineNumber += 1;
  }
  return { diagnostics, records, rowsSeen };
};

type CsvRecord = { fields: string[]; line: number };

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
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        field += character;
        if (character === '\n') line += 1;
      }
      continue;
    }
    if (closedQuote && character !== ',' && character !== '\n' && character !== '\r') {
      diagnostics.push(
        diagnostic(
          'malformed_csv',
          'Unexpected character after a closing CSV quote.',
          'Follow a closing quote with a delimiter, newline, or end of input.',
          { line },
        ),
      );
      closedQuote = false;
    }
    if (character === '"' && !closedQuote) {
      if (field.length === 0) {
        quoted = true;
      } else {
        diagnostics.push(
          diagnostic(
            'malformed_csv',
            'A CSV quote cannot begin inside an unquoted field.',
            'Quote the complete field and escape embedded quotes by doubling them.',
            { line },
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
      diagnostic(
        'malformed_csv',
        'CSV input ends inside a quoted field.',
        'Close the quoted field before end of input.',
        { line: recordLine },
      ),
    );
  }
  if (field.length > 0 || fields.length > 0 || (text.length > 0 && !/[\r\n]$/u.test(text))) {
    fields.push(field);
    records.push({ fields, line: recordLine });
  }
  return { diagnostics, records };
};

const parseCsvSource = (
  text: string,
  maxRows: number,
): Pick<ParsedImportSource, 'diagnostics' | 'records' | 'rowsSeen'> => {
  const parsed = parseCsvRecords(text, maxRows + 2);
  const diagnostics = [...parsed.diagnostics];
  const [headerRecord, ...dataRecords] = parsed.records;
  if (headerRecord === undefined) {
    diagnostics.push(
      diagnostic(
        'csv_header_missing',
        'CSV input has no header row.',
        'Provide one unique header row.',
      ),
    );
    return { diagnostics, records: [], rowsSeen: 0 };
  }
  const headers = headerRecord.fields;
  const seenHeaders = new Set<string>();
  headers.forEach((header, index) => {
    if (seenHeaders.has(header)) {
      diagnostics.push({
        ...diagnostic(
          'duplicate_csv_header',
          `CSV header ${header || '<empty>'} is duplicated.`,
          'Rename every CSV header so it is unique.',
          { line: headerRecord.line },
        ),
        source_field: header || `<column-${index + 1}>`,
      });
    }
    seenHeaders.add(header);
  });
  const records = dataRecords.flatMap(({ fields, line }) => {
    // Ignore a physically blank trailing/data row, but retain authored empty comma-delimited rows.
    if (fields.length === 1 && fields[0] === '') return [];
    if (fields.length !== headers.length) {
      diagnostics.push(
        diagnostic(
          'csv_column_count',
          `CSV row has ${fields.length} fields but the header has ${headers.length}.`,
          'Add or remove delimiters so every row matches the header width.',
          { row: line },
        ),
      );
    }
    return [
      {
        row: line,
        value: Object.fromEntries(headers.map((header, index) => [header, fields[index] ?? ''])),
      },
    ];
  });
  return { diagnostics, records, rowsSeen: dataRecords.length };
};

/** Returns the authored CSV header after the same fatal UTF-8 and strict quote checks as import. */
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

/** Decodes and parses the complete bounded source before normalization or reconciliation begins. */
const parseImportSource = (
  source: string | Uint8Array,
  format: ImportFormat,
  options: { limits?: Partial<ImportLimits>; recordsPointer?: string } = {},
): ParsedImportSource => {
  const limits = { ...DEFAULT_IMPORT_LIMITS, ...options.limits };
  const decoded = decodeSource(source);
  const sourceHash = createHash('sha256').update(decoded.bytes).digest('hex');
  if (decoded.bytes.byteLength > limits.maxBytes) {
    return {
      diagnostics: [
        diagnostic(
          'import_size_limit',
          `Import source exceeds the ${limits.maxBytes}-byte limit.`,
          'Split the source into smaller explicit imports.',
        ),
      ],
      records: [],
      rowsSeen: 0,
      sourceHash,
    };
  }
  if (decoded.diagnostics.length > 0) {
    return { diagnostics: decoded.diagnostics, records: [], rowsSeen: 0, sourceHash };
  }
  const parsed =
    format === 'csv'
      ? parseCsvSource(decoded.text, limits.maxRows)
      : format === 'json'
        ? parseJsonSource(decoded.text, options.recordsPointer, limits.maxRows)
        : parseJsonlSource(decoded.text, limits.maxRows);
  if (parsed.rowsSeen > limits.maxRows) {
    parsed.diagnostics.push(
      diagnostic(
        'import_row_limit',
        `Import source exceeds the ${limits.maxRows}-row limit.`,
        'Split the source into smaller explicit imports.',
      ),
    );
  }
  return {
    diagnostics: parsed.diagnostics,
    records: parsed.records.slice(0, limits.maxRows),
    rowsSeen: parsed.rowsSeen,
    sourceHash,
  };
};

export {
  collectBoundedImportSource,
  DEFAULT_IMPORT_LIMITS,
  discoverCsvHeaders,
  parseImportSource,
  resolveJsonPointer,
  type ParsedImportSource,
  type SourceRecord,
};
