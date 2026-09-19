import type { TestCase } from '@attest/contracts';

import { fingerprintCaseContent } from './canonical-import.js';
import {
  createImportDiagnostic as diagnostic,
  sortImportDiagnostics,
  type NormalizedImportRow,
} from './import-internal.js';
import {
  TabularImportError,
  type ImportDecision,
  type TabularImportRequest,
  type TabularImportResult,
} from './import-types.js';

/** Applies collision and update policy to normalized import rows. */
const reconcileRows = (
  rows: readonly NormalizedImportRow[],
  request: TabularImportRequest,
  dedupeSkipped: number,
  dedupeDecisions: readonly ImportDecision[],
): Omit<TabularImportResult, 'format' | 'importedCases' | 'preview' | 'sourceHash'> => {
  const sync = request.sync ?? 'append';
  const conflict = request.onConflict ?? (sync === 'upsert' ? 'update' : 'error');
  const cases: TestCase[] = structuredClone([...(request.existingCases ?? [])]);
  const collisionContexts = [
    ...((request.collisionCases ?? []).length === 0
      ? []
      : [{ cases: request.collisionCases ?? [] }]),
    ...(request.collisionContexts ?? []),
  ];
  const diagnostics = [];
  const decisions: ImportDecision[] = [...dedupeDecisions];
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
    const collides = collisionContexts.some(
      ({ cases: collisionCases, requiredTags }) =>
        (requiredTags ?? []).every((tag) => (row.case.tags ?? []).includes(tag)) &&
        collisionCases.some(({ id }) => id === row.case.id),
    );
    if (collides) {
      if (conflict === 'skip') {
        skipped += 1;
        decisions.push({ action: 'skip', case_id: row.case.id, matched_by: 'id', ...row.location });
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
    const matchedBy = idIndex >= 0 ? (row.identitySource === 'key' ? 'key' : 'id') : 'content';
    if (matchIndex < 0) {
      cases.push(row.case);
      inserted += 1;
      decisions.push({ action: 'insert', case_id: row.case.id });
      continue;
    }
    if (conflict === 'skip') {
      skipped += 1;
      decisions.push({
        action: 'skip',
        case_id: cases[matchIndex]!.id,
        matched_by: matchedBy,
        ...row.location,
      });
      continue;
    }
    if (conflict === 'update') {
      const stableId = cases[matchIndex]!.id;
      cases[matchIndex] = { ...row.case, id: stableId };
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

  if (diagnostics.length > 0) {
    throw new TabularImportError(
      'Imported cases conflict with existing project cases.',
      sortImportDiagnostics(diagnostics),
    );
  }
  return {
    cases,
    counts: { inserted, read: rows.length + dedupeSkipped, skipped, updated },
    decisions,
  };
};

export { reconcileRows };
