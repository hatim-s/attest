import {
  CASE_SCHEMA_ID,
  testCaseSchema,
  type DatasetImportMapping,
  type JsonValue,
  type TestCase,
} from '@attest/contracts';
import type { z } from 'zod';

import { contentHash } from '../store/internal/canonical-json.js';
import {
  createContentCaseId,
  createKeyedCaseId,
  fingerprintCaseContent,
} from './canonical-import.js';
import { importDiagnostic, importLocation } from './import-diagnostics.js';
import type {
  ImportDiagnostic,
  ImportFormat,
  NormalizedImportRow,
  SourceRecord,
  TabularImportRequest,
} from './import-types.js';
import { resolveJsonPointer, toPointer } from './json-pointer.js';
import { destinationPointer, splitDestination } from './validate-import-mappings.js';

type JsonObject = SourceRecord['value'];

/** The id is optional here because unkeyed rows get a content-derived id after validation. */
const importedCaseSchema = testCaseSchema.partial({ id: true });

/** CSV sources name a header; JSON sources are pointers into the record. */
const sourceValue = (record: JsonObject, source: string, format: ImportFormat) => {
  if (format !== 'csv') return resolveJsonPointer(record, source);
  if (!Object.hasOwn(record, source)) return { found: false } as const;
  return { found: true, value: record[source]! } as const;
};

const parseStructuredCsvFields = (
  record: SourceRecord,
  sources: readonly string[],
  diagnostics: ImportDiagnostic[],
): JsonObject => {
  const value = { ...record.value };
  for (const source of sources) {
    if (!Object.hasOwn(value, source)) {
      diagnostics.push(
        importDiagnostic({
          code: 'source_field_missing',
          message: 'A --parse-json source column is missing.',
          hint: 'Use an exact CSV header name.',
          sourceField: source,
          location: record,
        }),
      );
      continue;
    }
    const cell = value[source];
    // CSV cells are strings; a non-string cell was already decoded by a repeated --parse-json.
    if (typeof cell !== 'string') continue;
    try {
      value[source] = JSON.parse(cell) as JsonValue;
    } catch {
      diagnostics.push(
        importDiagnostic({
          code: 'invalid_cell_json',
          message: 'A structured CSV cell is not valid JSON.',
          hint: 'Repair the cell or remove this --parse-json option.',
          sourceField: source,
          location: record,
        }),
      );
    }
  }
  return value;
};

/** Writes a value at a dotted destination, creating intermediate objects without merging arrays. */
const assignDestination = (target: JsonObject, destination: string, value: JsonValue): void => {
  const segments = splitDestination(destination);
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const existing = Object.hasOwn(current, segment) ? current[segment] : undefined;
    if (existing !== null && typeof existing === 'object' && !Array.isArray(existing)) {
      current = existing;
      continue;
    }
    const child: JsonObject = {};
    current[segment] = child;
    current = child;
  }
  current[segments.at(-1)!] = value;
};

/** Attributes each validation issue to the most specific mapping that wrote its destination. */
const schemaDiagnostics = (
  issues: readonly z.core.$ZodIssue[],
  mappings: readonly DatasetImportMapping[],
  record: SourceRecord,
): ImportDiagnostic[] => {
  const mapped = mappings
    .map(({ destination, source }) => ({ destination: destinationPointer(destination), source }))
    .toSorted((left, right) => right.destination.length - left.destination.length);
  return issues.flatMap((issue) => {
    const paths =
      issue.code === 'unrecognized_keys'
        ? issue.keys.map((key) => [...issue.path, key])
        : [issue.path];
    return paths
      .map(toPointer)
      .toSorted()
      .map((destinationPath) => {
        const authored = mapped.find(
          ({ destination }) =>
            destinationPath === destination || destinationPath.startsWith(`${destination}/`),
        );
        return importDiagnostic({
          code: issue.code,
          message: issue.message,
          hint: `Repair this field to match ${CASE_SCHEMA_ID}.`,
          sourceField: authored?.source ?? (destinationPath || '<record>'),
          destinationPath,
          location: record,
        });
      });
  });
};

const mapRecord = (
  value: JsonObject,
  record: SourceRecord,
  request: TabularImportRequest,
  diagnostics: ImportDiagnostic[],
): JsonObject => {
  const mappings = request.mappings ?? [];
  if (mappings.length === 0) return value;
  const candidate: JsonObject = {};
  for (const mapping of mappings) {
    const resolved = sourceValue(value, mapping.source, request.format);
    if (resolved.found) {
      assignDestination(candidate, mapping.destination, resolved.value);
      continue;
    }
    diagnostics.push(
      importDiagnostic({
        code: 'source_field_missing',
        message: 'A mapped source field is missing.',
        hint:
          request.format === 'csv'
            ? 'Use an exact CSV header name.'
            : 'Use an RFC 6901 pointer that resolves in every record.',
        sourceField: mapping.source,
        destinationPath: destinationPointer(mapping.destination),
        location: record,
      }),
    );
  }
  return candidate;
};

const resolveSourceKey = (
  value: JsonObject,
  record: SourceRecord,
  request: TabularImportRequest,
  diagnostics: ImportDiagnostic[],
): JsonValue | undefined => {
  if (request.keySource === undefined) return undefined;
  const resolved = sourceValue(value, request.keySource, request.format);
  if (resolved.found) return resolved.value;
  diagnostics.push(
    importDiagnostic({
      code: 'source_key_missing',
      message: 'The stable source key is missing from this record.',
      hint: 'Choose a key present in every imported record.',
      sourceField: request.keySource,
      destinationPath: '/id',
      location: record,
    }),
  );
  return undefined;
};

const caseIdentity = (
  content: Omit<TestCase, 'id'>,
  explicitId: string | undefined,
  sourceKey: JsonValue | undefined,
): { id: string; source: NormalizedImportRow['identitySource'] } => {
  if (explicitId !== undefined) return { id: explicitId, source: 'id' };
  if (sourceKey !== undefined) return { id: createKeyedCaseId(sourceKey), source: 'key' };
  return { id: createContentCaseId(content), source: 'content' };
};

/**
 * Maps one source record onto the case shape, validates it, and assigns its id: an explicit
 * mapped id wins, then the source key, then the case content.
 */
const normalizeRecord = (
  record: SourceRecord,
  request: TabularImportRequest,
): { diagnostics: ImportDiagnostic[]; row?: NormalizedImportRow } => {
  const diagnostics: ImportDiagnostic[] = [];
  let value = record.value;
  if (request.format === 'csv') {
    value = parseStructuredCsvFields(record, request.parseJsonSources ?? [], diagnostics);
  }
  const candidate = mapRecord(value, record, request, diagnostics);
  const sourceKey = resolveSourceKey(value, record, request, diagnostics);
  const parsed = importedCaseSchema.safeParse(candidate);
  if (!parsed.success) {
    diagnostics.push(...schemaDiagnostics(parsed.error.issues, request.mappings ?? [], record));
    return { diagnostics };
  }
  if (diagnostics.length > 0) return { diagnostics };

  const { id: explicitId, ...content } = parsed.data;
  const identity = caseIdentity(content, explicitId, sourceKey);
  const testCase = { ...content, id: identity.id };
  const row: NormalizedImportRow = {
    case: testCase,
    contentFingerprint: fingerprintCaseContent(testCase),
    identitySource: identity.source,
    location: importLocation(record),
  };
  if (sourceKey !== undefined) row.sourceKeyFingerprint = contentHash(sourceKey);
  return { diagnostics, row };
};

export { normalizeRecord };
