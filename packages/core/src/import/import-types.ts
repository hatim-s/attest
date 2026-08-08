import type { DatasetImportMapping, TestCase } from '@attest/contracts';

type ImportFormat = 'csv' | 'json' | 'jsonl';
type ImportDedupePolicy = 'content' | 'id' | 'key';
type ImportConflictPolicy = 'error' | 'skip' | 'update';
type ImportSyncPolicy = 'append' | 'upsert';
type ImportLocation = { line?: number; row?: number };

type ImportDiagnostic = ImportLocation & {
  code: string;
  destination_path: string;
  hint: string;
  message: string;
  source_field: string;
};

type ImportLimits = {
  maxBytes: number;
  maxRows: number;
};

type ImportDecision = {
  action: 'insert' | 'skip' | 'update';
  case_id: string;
  matched_by?: 'content' | 'id' | 'key';
};

type ImportCounts = {
  inserted: number;
  read: number;
  skipped: number;
  updated: number;
};

type TabularImportRequest = {
  collisionCases?: readonly TestCase[];
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
};

type TabularImportResult = {
  cases: TestCase[];
  counts: ImportCounts;
  decisions: ImportDecision[];
  format: ImportFormat;
  importedCases: TestCase[];
  preview: unknown[];
  sourceHash: string;
};

/** Carries stable, aggregate diagnostics without coupling the reusable engine to CLI rendering. */
class TabularImportError extends Error {
  readonly diagnostics: readonly ImportDiagnostic[];

  constructor(message: string, diagnostics: readonly ImportDiagnostic[]) {
    super(message);
    this.name = 'TabularImportError';
    this.diagnostics = diagnostics;
  }
}

export {
  TabularImportError,
  type ImportConflictPolicy,
  type ImportCounts,
  type ImportDecision,
  type ImportDedupePolicy,
  type ImportDiagnostic,
  type ImportFormat,
  type ImportLimits,
  type ImportLocation,
  type ImportSyncPolicy,
  type TabularImportRequest,
  type TabularImportResult,
};
