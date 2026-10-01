import type { TestCase } from '@attest/contracts';

import { fingerprintCaseContent } from './canonical-import.js';
import { importDiagnostic, sortImportDiagnostics } from './import-diagnostics.js';
import {
  TabularImportError,
  type DedupedRows,
  type ImportDecision,
  type ImportDiagnostic,
  type NormalizedImportRow,
  type ReconciledImport,
  type TabularImportRequest,
} from './import-types.js';

type MatchBasis = NonNullable<ImportDecision['matched_by']>;

const collidesOutsideTarget = (row: NormalizedImportRow, request: TabularImportRequest): boolean =>
  (request.collisionContexts ?? []).some(
    ({ cases, requiredTags }) =>
      (requiredTags ?? []).every((tag) => (row.case.tags ?? []).includes(tag)) &&
      cases.some(({ id }) => id === row.case.id),
  );

const idMatchBasis = (row: NormalizedImportRow): MatchBasis =>
  row.identitySource === 'key' ? 'key' : 'id';

const conflictDestination = (matchedBy: MatchBasis): string => {
  if (matchedBy === 'content') return '';
  return '/id';
};

const upsertIdentityDiagnostics = (rows: readonly NormalizedImportRow[]): ImportDiagnostic[] =>
  rows
    .filter((row) => row.identitySource === 'content')
    .map((row) =>
      importDiagnostic({
        code: 'upsert_identity_required',
        message: 'Upsert requires an explicit mapped id or stable source key.',
        hint: 'Map id or pass --key so changed content retains its case identity.',
        sourceField: '<identity>',
        destinationPath: '/id',
        location: row.location,
      }),
    );

/**
 * Applies sync and conflict policy against the target's existing cases. Matching is by id first,
 * then by content. Existing cases absent from the source are never deleted.
 */
const reconcileRows = (deduped: DedupedRows, request: TabularImportRequest): ReconciledImport => {
  const sync = request.sync ?? 'append';
  const conflict = request.onConflict ?? (sync === 'upsert' ? 'update' : 'error');
  const cases: TestCase[] = (request.existingCases ?? []).map((testCase) =>
    structuredClone(testCase),
  );
  // Kept in step with `cases` so each case is hashed once rather than once per imported row.
  const fingerprints = cases.map(fingerprintCaseContent);
  const diagnostics: ImportDiagnostic[] = [];
  const decisions: ImportDecision[] = [...deduped.decisions];
  let inserted = 0;
  let skipped = deduped.skipped;
  let updated = 0;

  if (sync === 'upsert') diagnostics.push(...upsertIdentityDiagnostics(deduped.rows));

  for (const row of deduped.rows) {
    if (collidesOutsideTarget(row, request)) {
      if (conflict === 'skip') {
        skipped += 1;
        decisions.push({ action: 'skip', case_id: row.case.id, matched_by: 'id', ...row.location });
        continue;
      }
      diagnostics.push(
        importDiagnostic({
          code: 'resolved_case_collision',
          message:
            'Imported case id collides with a direct or attached case outside the import target.',
          hint: 'Choose an explicit non-colliding id or use --on-conflict skip.',
          sourceField: 'id',
          destinationPath: '/id',
          location: row.location,
        }),
      );
      continue;
    }

    const idIndex = cases.findIndex(({ id }) => id === row.case.id);
    const matchIndex = idIndex >= 0 ? idIndex : fingerprints.indexOf(row.contentFingerprint);
    if (matchIndex < 0) {
      cases.push(row.case);
      fingerprints.push(row.contentFingerprint);
      inserted += 1;
      decisions.push({ action: 'insert', case_id: row.case.id });
      continue;
    }
    const matchedBy: MatchBasis = idIndex >= 0 ? idMatchBasis(row) : 'content';
    const stableId = cases[matchIndex]!.id;
    if (conflict === 'skip') {
      skipped += 1;
      decisions.push({ action: 'skip', case_id: stableId, matched_by: matchedBy, ...row.location });
      continue;
    }
    if (conflict === 'update') {
      cases[matchIndex] = { ...row.case, id: stableId };
      fingerprints[matchIndex] = row.contentFingerprint;
      updated += 1;
      decisions.push({
        action: 'update',
        case_id: stableId,
        matched_by: matchedBy,
        ...row.location,
      });
      continue;
    }
    diagnostics.push(
      importDiagnostic({
        code: 'existing_case_conflict',
        message: `Imported case conflicts with existing ${matchedBy}.`,
        hint: 'Pass --on-conflict skip|update or repair the source identity.',
        sourceField: matchedBy,
        destinationPath: conflictDestination(matchedBy),
        location: row.location,
      }),
    );
  }

  if (diagnostics.length > 0) {
    throw new TabularImportError(
      'Imported cases conflict with existing project cases.',
      sortImportDiagnostics(diagnostics),
    );
  }
  return {
    cases,
    counts: { inserted, read: deduped.rows.length + deduped.skipped, skipped, updated },
    decisions,
  };
};

export { reconcileRows };
