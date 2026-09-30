import {
  AttestError,
  type DatasetImportMapping,
  type JsonValue,
  type TestCase,
} from '@attest/contracts';
import type { z } from 'zod';

type ImportFormat = 'csv' | 'json' | 'jsonl';
type ImportDedupePolicy = 'content' | 'id' | 'key';
type ImportConflictPolicy = 'error' | 'skip' | 'update';
type ImportSyncPolicy = 'append' | 'upsert';

/** Physical source coordinates: `line` for JSONL and CSV syntax, `row` for records. */
interface ImportLocation {
  line?: number;
  row?: number;
}

/** Every diagnostic the import engine emits, plus the Zod issue codes from case validation. */
type ImportDiagnosticCode =
  | 'csv_column_count'
  | 'csv_header_missing'
  | 'dedupe_key_required'
  | 'duplicate_content'
  | 'duplicate_csv_header'
  | 'duplicate_id'
  | 'duplicate_key'
  | 'existing_case_conflict'
  | 'import_row_limit'
  | 'import_size_limit'
  | 'invalid_cell_json'
  | 'invalid_json'
  | 'invalid_utf8'
  | 'malformed_csv'
  | 'mapping_destination_conflict'
  | 'mapping_destination_renamed'
  | 'mapping_destination_unsafe'
  | 'mapping_required'
  | 'parse_json_format'
  | 'record_not_object'
  | 'records_not_array'
  | 'records_pointer_format'
  | 'records_pointer_missing'
  | 'resolved_case_collision'
  | 'source_field_missing'
  | 'source_key_missing'
  | 'source_pointer_required'
  | 'upsert_identity_required'
  | z.core.$ZodIssue['code'];

/** One import problem located by source field and destination, never by authored value. */
type ImportDiagnostic = ImportLocation & {
  code: ImportDiagnosticCode;
  destination_path: string;
  hint: string;
  message: string;
  source_field: string;
};

interface ImportLimits {
  maxBytes: number;
  maxRows: number;
}

type ImportDecision = ImportLocation & {
  action: 'insert' | 'skip' | 'update';
  case_id: string;
  matched_by?: ImportDedupePolicy;
};

/**
 * Cases outside the import target whose ids an imported case must not reuse. `requiredTags`
 * limits the check to imported cases an attachment filter would actually pull in.
 */
interface ImportCollisionContext {
  cases: readonly TestCase[];
  requiredTags?: readonly string[];
}

interface ImportCounts {
  inserted: number;
  read: number;
  skipped: number;
  updated: number;
}

interface TabularImportRequest {
  collisionContexts?: readonly ImportCollisionContext[];
  dedupe?: ImportDedupePolicy;
  existingCases?: readonly TestCase[];
  format: ImportFormat;
  keySource?: string;
  limits?: Partial<ImportLimits>;
  mappings?: readonly DatasetImportMapping[];
  onConflict?: ImportConflictPolicy;
  parseJsonSources?: readonly string[];
  recordsPointer?: string;
  source: string | Uint8Array;
  sync?: ImportSyncPolicy;
}

/** One parsed source record: a JSON object, or a CSV row keyed by header. */
type SourceRecord = ImportLocation & { value: { [field: string]: JsonValue } };

/** Parsed records plus how many the source held, which may exceed the records kept. */
interface ParsedRecords {
  diagnostics: ImportDiagnostic[];
  records: SourceRecord[];
  rowsSeen: number;
}

/** A validated import row with the identity basis its case id came from. */
interface NormalizedImportRow {
  case: TestCase;
  contentFingerprint: string;
  identitySource: ImportDedupePolicy;
  location: ImportLocation;
  sourceKeyFingerprint?: string;
}

/** Rows left after within-import dedupe, with the skips dedupe already decided. */
interface DedupedRows {
  decisions: ImportDecision[];
  rows: NormalizedImportRow[];
  skipped: number;
}

/** The target case list after applying sync and conflict policy, with one decision per row. */
interface ReconciledImport {
  cases: TestCase[];
  counts: ImportCounts;
  decisions: ImportDecision[];
}

/** Authored values replaced by their type, so previews can be shown without leaking data. */
type RedactedValue = null | string | RedactedValue[] | { [key: string]: RedactedValue };

type TabularImportResult = ReconciledImport & {
  format: ImportFormat;
  preview: Array<Record<string, RedactedValue>>;
  sourceHash: string;
};

/** Carries every import diagnostic at once so callers can report the whole batch. */
class TabularImportError extends AttestError {
  declare readonly code: 'import_invalid';
  readonly diagnostics: readonly ImportDiagnostic[];

  constructor(message: string, diagnostics: readonly ImportDiagnostic[]) {
    super('import_invalid', message);
    this.diagnostics = diagnostics;
  }
}

export {
  TabularImportError,
  type DedupedRows,
  type ImportCollisionContext,
  type ImportDecision,
  type ImportDiagnostic,
  type ImportDiagnosticCode,
  type ImportFormat,
  type ImportLimits,
  type ImportLocation,
  type NormalizedImportRow,
  type ParsedRecords,
  type ReconciledImport,
  type RedactedValue,
  type SourceRecord,
  type TabularImportRequest,
  type TabularImportResult,
};
