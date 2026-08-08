import {
  CASE_SCHEMA_VERSION,
  testCaseSchema,
  type DatasetImportMapping,
  type TestCase,
} from '@attest/contracts';

import {
  caseContentWithoutId,
  createContentCaseId,
  createKeyedCaseId,
  fingerprintCaseContent,
  hashImportJson,
  type JsonValue,
} from './canonical-import.js';
import {
  TabularImportError,
  type ImportDecision,
  type ImportDiagnostic,
  type ImportLocation,
  type TabularImportRequest,
  type TabularImportResult,
} from './import-types.js';
import { parseImportSource, resolveJsonPointer, type SourceRecord } from './parse-import-source.js';

type NormalizedImportRow = {
  case: TestCase;
  contentFingerprint: string;
  explicitId: boolean;
  generatedFromContent: boolean;
  location: ImportLocation;
  sourceKeyFingerprint?: string;
};

const escapePointerSegment = (segment: PropertyKey): string =>
  String(segment).replaceAll('~', '~0').replaceAll('/', '~1');

const destinationPathsForIssue = (issue: {
  code: string;
  keys?: readonly string[];
  path: PropertyKey[];
}): string[] => {
  const paths =
    issue.code === 'unrecognized_keys' && issue.keys !== undefined
      ? issue.keys.map((key) => [...issue.path, key])
      : [issue.path];
  return paths
    .map((path) => (path.length === 0 ? '' : `/${path.map(escapePointerSegment).join('/')}`))
    .sort();
};

const diagnostic = (
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

const sortDiagnostics = (diagnostics: readonly ImportDiagnostic[]): ImportDiagnostic[] =>
  [...diagnostics].sort(
    (left, right) =>
      (left.line ?? left.row ?? 0) - (right.line ?? right.row ?? 0) ||
      left.source_field.localeCompare(right.source_field, 'en') ||
      left.destination_path.localeCompare(right.destination_path, 'en') ||
      left.code.localeCompare(right.code, 'en'),
  );

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

const assertMappingShape = (
  format: TabularImportRequest['format'],
  mappings: readonly DatasetImportMapping[],
): ImportDiagnostic[] => {
  const diagnostics: ImportDiagnostic[] = [];
  if (format === 'csv' && mappings.length === 0) {
    diagnostics.push(
      diagnostic(
        'mapping_required',
        'CSV imports require at least one explicit field mapping.',
        'Pass --map input=<header> and any other required mappings.',
        '<mapping>',
        '',
      ),
    );
  }
  const destinations = mappings.map(({ destination }) => splitDestination(destination));
  destinations.forEach((path, index) => {
    if (path.some((segment) => ['__proto__', 'constructor', 'prototype'].includes(segment))) {
      diagnostics.push(
        diagnostic(
          'mapping_destination_unsafe',
          'Mapping destinations cannot contain prototype-mutating path segments.',
          'Rename the destination field to a plain data key.',
          mappings[index]!.source,
          `/${path.map(escapePointerSegment).join('/')}`,
        ),
      );
    }
    destinations.slice(0, index).forEach((prior, priorIndex) => {
      const common = Math.min(path.length, prior.length);
      if (path.slice(0, common).join('\0') === prior.slice(0, common).join('\0')) {
        diagnostics.push(
          diagnostic(
            'mapping_destination_conflict',
            `Mappings ${priorIndex + 1} and ${index + 1} target overlapping destinations.`,
            'Map either a whole value or its nested fields, not both.',
            mappings[index]!.source,
            `/${path.map(escapePointerSegment).join('/')}`,
          ),
        );
      }
    });
  });
  mappings.forEach(({ source }, index) => {
    if (format !== 'csv' && !source.startsWith('/')) {
      diagnostics.push(
        diagnostic(
          'source_pointer_required',
          'JSON and JSONL mapping sources must be RFC 6901 pointers.',
          'Prefix the source with `/` and escape `~` or `/` pointer segments.',
          source,
          `/${splitDestination(mappings[index]!.destination).map(escapePointerSegment).join('/')}`,
        ),
      );
    }
  });
  return diagnostics;
};

const sourceValue = (
  record: Record<string, unknown>,
  source: string,
  format: TabularImportRequest['format'],
): { found: boolean; value?: unknown } =>
  format === 'csv'
    ? { found: Object.hasOwn(record, source), value: record[source] }
    : resolveJsonPointer(record, source);

const parseStructuredCsvFields = (
  record: SourceRecord,
  sources: readonly string[],
): { diagnostics: ImportDiagnostic[]; value: Record<string, unknown> } => {
  const diagnostics: ImportDiagnostic[] = [];
  const value = { ...record.value };
  for (const source of sources) {
    if (!Object.hasOwn(value, source)) {
      diagnostics.push(
        diagnostic(
          'source_field_missing',
          'A --parse-json source column is missing.',
          'Use an exact CSV header name.',
          source,
          '',
          record,
        ),
      );
      continue;
    }
    try {
      value[source] = JSON.parse(String(value[source])) as unknown;
    } catch {
      diagnostics.push(
        diagnostic(
          'invalid_cell_json',
          'A structured CSV cell is not valid JSON.',
          'Repair the cell or remove this --parse-json option.',
          source,
          '',
          record,
        ),
      );
    }
  }
  return { diagnostics, value };
};

const assignDestination = (
  target: Record<string, unknown>,
  destination: string,
  value: unknown,
): void => {
  const segments = splitDestination(destination);
  if (segments.some((segment) => ['__proto__', 'constructor', 'prototype'].includes(segment))) {
    return;
  }
  if (segments[0] === 'metrics') {
    target.metric_overrides = Array.isArray(value)
      ? (value as unknown[]).map((entry) =>
          typeof entry === 'string' ? { metric_id: entry } : entry,
        )
      : value;
    return;
  }
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const existing = Object.hasOwn(current, segment) ? current[segment] : undefined;
    const child =
      existing !== null && typeof existing === 'object' && !Array.isArray(existing)
        ? (existing as Record<string, unknown>)
        : {};
    if (existing !== child) current[segment] = child;
    current = child;
  }
  current[segments.at(-1)!] = value;
};

const normalizeRecord = (
  sourceRecord: SourceRecord,
  request: TabularImportRequest,
): { diagnostics: ImportDiagnostic[]; row?: NormalizedImportRow } => {
  const parsedCsv =
    request.format === 'csv'
      ? parseStructuredCsvFields(sourceRecord, request.parseJsonSources ?? [])
      : { diagnostics: [], value: sourceRecord.value };
  const diagnostics = [...parsedCsv.diagnostics];
  const mappings = request.mappings ?? [];
  const candidate: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (mappings.length === 0) {
    Object.assign(candidate, parsedCsv.value);
  } else {
    for (const mapping of mappings) {
      const resolved = sourceValue(parsedCsv.value, mapping.source, request.format);
      if (!resolved.found) {
        diagnostics.push(
          diagnostic(
            'source_field_missing',
            'A mapped source field is missing.',
            request.format === 'csv'
              ? 'Use an exact CSV header name.'
              : 'Use an RFC 6901 pointer that resolves in every record.',
            mapping.source,
            `/${splitDestination(mapping.destination).map(escapePointerSegment).join('/')}`,
            sourceRecord,
          ),
        );
      } else {
        assignDestination(candidate, mapping.destination, resolved.value);
      }
    }
  }

  let sourceKey: unknown;
  if (request.keySource !== undefined) {
    const resolved = sourceValue(parsedCsv.value, request.keySource, request.format);
    if (!resolved.found) {
      diagnostics.push(
        diagnostic(
          'source_key_missing',
          'The stable source key is missing from this record.',
          'Choose a key present in every imported record.',
          request.keySource,
          '/id',
          sourceRecord,
        ),
      );
    } else {
      sourceKey = resolved.value;
    }
  }

  const explicitId = candidate.id !== undefined;
  const placeholder = { ...candidate, id: explicitId ? candidate.id : 'case-pending' };
  const parsed = testCaseSchema.safeParse(placeholder);
  if (!parsed.success) {
    diagnostics.push(
      ...parsed.error.issues.flatMap((issue) =>
        destinationPathsForIssue(issue).map((destinationPath) =>
          diagnostic(
            issue.code,
            issue.message,
            `Repair this field to match ${CASE_SCHEMA_VERSION}.`,
            destinationPath === '' ? '<record>' : destinationPath,
            destinationPath,
            sourceRecord,
          ),
        ),
      ),
    );
  }
  if (diagnostics.length > 0 || !parsed.success) return { diagnostics };

  const withoutPlaceholder = caseContentWithoutId(parsed.data);
  const generatedFromContent = !explicitId && request.keySource === undefined;
  const id = explicitId
    ? parsed.data.id
    : sourceKey === undefined
      ? createContentCaseId(withoutPlaceholder)
      : createKeyedCaseId(sourceKey as JsonValue);
  const testCase = { ...withoutPlaceholder, id };
  return {
    diagnostics,
    row: {
      case: testCase,
      contentFingerprint: fingerprintCaseContent(testCase),
      explicitId,
      generatedFromContent,
      location: {
        ...(sourceRecord.line === undefined ? {} : { line: sourceRecord.line }),
        ...(sourceRecord.row === undefined ? {} : { row: sourceRecord.row }),
      },
      ...(sourceKey === undefined
        ? {}
        : { sourceKeyFingerprint: hashImportJson(sourceKey as JsonValue) }),
    },
  };
};

const dedupeRows = (
  rows: readonly NormalizedImportRow[],
  request: TabularImportRequest,
): { diagnostics: ImportDiagnostic[]; rows: NormalizedImportRow[]; skipped: number } => {
  const diagnostics: ImportDiagnostic[] = [];
  if (request.dedupe === 'key' && request.keySource === undefined) {
    diagnostics.push(
      diagnostic(
        'dedupe_key_required',
        'Key dedupe requires an explicit source key.',
        'Pass --key <source> or choose id/content dedupe.',
        '<key>',
        '',
      ),
    );
  }
  const seen = {
    content: new Map<string, number>(),
    id: new Map<string, number>(),
    key: new Map<string, number>(),
  };
  const kept: NormalizedImportRow[] = [];
  let skipped = 0;
  rows.forEach((row, index) => {
    const duplicates = {
      content: seen.content.get(row.contentFingerprint),
      id: seen.id.get(row.case.id),
      key:
        row.sourceKeyFingerprint === undefined ? undefined : seen.key.get(row.sourceKeyFingerprint),
    };
    if (request.dedupe !== undefined && duplicates[request.dedupe] !== undefined) {
      skipped += 1;
      return;
    }
    for (const [basis, prior] of Object.entries(duplicates) as [
      keyof typeof duplicates,
      number | undefined,
    ][]) {
      if (prior !== undefined) {
        diagnostics.push(
          diagnostic(
            `duplicate_${basis}`,
            `Imported record duplicates ${basis} from record ${prior + 1}.`,
            `Pass --dedupe ${basis} to keep the first record, or repair the duplicate.`,
            basis === 'key' ? (request.keySource ?? '<key>') : basis,
            basis === 'id' ? '/id' : '',
            row.location,
          ),
        );
      }
    }
    seen.content.set(row.contentFingerprint, index);
    seen.id.set(row.case.id, index);
    if (row.sourceKeyFingerprint !== undefined) seen.key.set(row.sourceKeyFingerprint, index);
    kept.push(row);
  });
  return { diagnostics, rows: kept, skipped };
};

const redactValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactValue(entry)]),
    );
  }
  if (value === null) return null;
  return `<redacted:${typeof value}>`;
};

/** Returns a normalized five-row preview with authored scalar values redacted. */
const createImportPreview = (rows: readonly NormalizedImportRow[]): unknown[] =>
  rows.slice(0, 5).map(({ case: testCase }) => ({
    id: testCase.id,
    ...(redactValue(caseContentWithoutId(testCase)) as Record<string, unknown>),
  }));

const reconcileRows = (
  rows: readonly NormalizedImportRow[],
  request: TabularImportRequest,
  dedupeSkipped: number,
): Omit<TabularImportResult, 'format' | 'importedCases' | 'preview' | 'sourceHash'> => {
  const sync = request.sync ?? 'append';
  const conflict = request.onConflict ?? (sync === 'upsert' ? 'update' : 'error');
  const cases: TestCase[] = structuredClone([...(request.existingCases ?? [])]);
  const collisionIds = new Set((request.collisionCases ?? []).map(({ id }) => id));
  const diagnostics: ImportDiagnostic[] = [];
  const decisions: ImportDecision[] = [];
  let inserted = 0;
  let skipped = dedupeSkipped;
  let updated = 0;

  if (sync === 'upsert') {
    rows.forEach((row) => {
      if (row.generatedFromContent) {
        diagnostics.push(
          diagnostic(
            'upsert_identity_required',
            'Upsert requires an explicit mapped id or stable source key.',
            'Map id or pass --key so changed content retains its case identity.',
            '<identity>',
            '/id',
            row.location,
          ),
        );
      }
    });
  }

  for (const row of rows) {
    if (collisionIds.has(row.case.id)) {
      if (conflict === 'skip') {
        skipped += 1;
        decisions.push({ action: 'skip', case_id: row.case.id, matched_by: 'id' });
      } else {
        diagnostics.push(
          diagnostic(
            'resolved_case_collision',
            'Imported case id collides with a direct or attached case outside the import target.',
            'Choose an explicit non-colliding id or use --on-conflict skip.',
            'id',
            '/id',
            row.location,
          ),
        );
      }
      continue;
    }
    const idIndex = cases.findIndex(({ id }) => id === row.case.id);
    const contentIndex = cases.findIndex(
      (testCase) => fingerprintCaseContent(testCase) === row.contentFingerprint,
    );
    const matchIndex = idIndex >= 0 ? idIndex : contentIndex;
    const matchedBy = idIndex >= 0 ? (request.keySource === undefined ? 'id' : 'key') : 'content';
    if (matchIndex < 0) {
      cases.push(row.case);
      inserted += 1;
      decisions.push({ action: 'insert', case_id: row.case.id });
      continue;
    }
    if (conflict === 'skip') {
      skipped += 1;
      decisions.push({ action: 'skip', case_id: cases[matchIndex]!.id, matched_by: matchedBy });
    } else if (conflict === 'update') {
      const stableId = cases[matchIndex]!.id;
      cases[matchIndex] = { ...row.case, id: stableId };
      updated += 1;
      decisions.push({ action: 'update', case_id: stableId, matched_by: matchedBy });
    } else {
      diagnostics.push(
        diagnostic(
          'existing_case_conflict',
          `Imported case conflicts with existing ${matchedBy}.`,
          'Pass --on-conflict skip|update or repair the source identity.',
          matchedBy,
          matchedBy === 'id' || matchedBy === 'key' ? '/id' : '',
          row.location,
        ),
      );
    }
  }
  if (diagnostics.length > 0) {
    throw new TabularImportError(
      'Imported cases conflict with existing project cases.',
      sortDiagnostics(diagnostics),
    );
  }
  return {
    cases,
    counts: { inserted, read: rows.length + dedupeSkipped, skipped, updated },
    decisions,
  };
};

/** Parses, maps, validates, deduplicates, and reconciles a complete bounded import in memory. */
const importTabularCases = (request: TabularImportRequest): TabularImportResult => {
  const mappings = request.mappings ?? [];
  const parsed = parseImportSource(request.source, request.format, {
    limits: request.limits,
    recordsPointer: request.recordsPointer,
  });
  const diagnostics = [...parsed.diagnostics, ...assertMappingShape(request.format, mappings)];
  if (request.recordsPointer !== undefined && request.format !== 'json') {
    diagnostics.push(
      diagnostic(
        'records_pointer_format',
        'A records pointer is supported only for JSON imports.',
        'Remove --records-pointer or select --format json.',
        '<records-pointer>',
        '',
      ),
    );
  }
  if ((request.parseJsonSources?.length ?? 0) > 0 && request.format !== 'csv') {
    diagnostics.push(
      diagnostic(
        'parse_json_format',
        '--parse-json is supported only for CSV columns.',
        'Remove --parse-json or select --format csv.',
        '<parse-json>',
        '',
      ),
    );
  }
  const rows: NormalizedImportRow[] = [];
  parsed.records.forEach((record) => {
    const normalized = normalizeRecord(record, request);
    diagnostics.push(...normalized.diagnostics);
    if (normalized.row !== undefined) rows.push(normalized.row);
  });
  const deduped = dedupeRows(rows, request);
  diagnostics.push(...deduped.diagnostics);
  if (diagnostics.length > 0) {
    throw new TabularImportError('Imported case validation failed.', sortDiagnostics(diagnostics));
  }
  const reconciled = reconcileRows(deduped.rows, request, deduped.skipped);
  return {
    ...reconciled,
    format: request.format,
    importedCases: deduped.rows.map(({ case: testCase }) => testCase),
    preview: createImportPreview(deduped.rows),
    sourceHash: parsed.sourceHash,
  };
};

export { createImportPreview, importTabularCases };
