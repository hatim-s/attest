import { importDiagnostic } from './import-diagnostics.js';
import type {
  DedupedRows,
  ImportDiagnostic,
  NormalizedImportRow,
  TabularImportRequest,
} from './import-types.js';

const DEDUPE_BASES = ['content', 'id', 'key'] as const;

type DedupeBasis = (typeof DEDUPE_BASES)[number];

interface SeenRow {
  index: number;
  row: NormalizedImportRow;
}

const basisValue = (row: NormalizedImportRow, basis: DedupeBasis): string | undefined => {
  switch (basis) {
    case 'content':
      return row.contentFingerprint;
    case 'id':
      return row.case.id;
    case 'key':
      return row.sourceKeyFingerprint;
  }
};

/**
 * Removes within-import duplicates. The selected `dedupe` basis keeps the first row and records a
 * skip; a duplicate on any other basis is an error, because silently dropping it would lose data.
 */
const dedupeImportRows = (
  rows: readonly NormalizedImportRow[],
  request: TabularImportRequest,
): DedupedRows & { diagnostics: ImportDiagnostic[] } => {
  const diagnostics: ImportDiagnostic[] = [];
  const decisions: DedupedRows['decisions'] = [];
  if (request.dedupe === 'key' && request.keySource === undefined) {
    diagnostics.push(
      importDiagnostic({
        code: 'dedupe_key_required',
        message: 'Key dedupe requires an explicit source key.',
        hint: 'Pass --key <source> or choose id/content dedupe.',
        sourceField: '<key>',
      }),
    );
  }
  const seen = {
    content: new Map<string, SeenRow>(),
    id: new Map<string, SeenRow>(),
    key: new Map<string, SeenRow>(),
  };
  const kept: NormalizedImportRow[] = [];
  let skipped = 0;
  for (const [index, row] of rows.entries()) {
    const priorFor = (basis: DedupeBasis): SeenRow | undefined => {
      const value = basisValue(row, basis);
      return value === undefined ? undefined : seen[basis].get(value);
    };
    const selectedPrior = request.dedupe === undefined ? undefined : priorFor(request.dedupe);
    if (request.dedupe !== undefined && selectedPrior !== undefined) {
      skipped += 1;
      decisions.push({
        action: 'skip',
        case_id: selectedPrior.row.case.id,
        matched_by: request.dedupe,
        ...row.location,
      });
      continue;
    }
    for (const basis of DEDUPE_BASES) {
      const prior = priorFor(basis);
      if (prior !== undefined) {
        diagnostics.push(
          importDiagnostic({
            code: `duplicate_${basis}`,
            message: `Imported record duplicates ${basis} from record ${prior.index + 1}.`,
            hint: `Pass --dedupe ${basis} to keep the first record, or repair the duplicate.`,
            sourceField: basis === 'key' ? (request.keySource ?? '<key>') : basis,
            destinationPath: basis === 'id' ? '/id' : '',
            location: row.location,
          }),
        );
      }
      const value = basisValue(row, basis);
      if (value !== undefined) seen[basis].set(value, { index, row });
    }
    kept.push(row);
  }
  return { decisions, diagnostics, rows: kept, skipped };
};

export { dedupeImportRows };
