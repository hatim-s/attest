import { createHash, randomUUID } from 'node:crypto';

import {
  AttestError,
  type CaseSelection,
  type CaseSelectionSummary,
  type EvalRunSelectedCase,
  type TestCase,
} from '@attest/contracts';

/** The fields of an authored case that selection filters and sampling read. */
type SelectableCase = Pick<EvalRunSelectedCase, 'test_id' | 'source'> & {
  case: Pick<TestCase, 'id' | 'tags' | 'folder'>;
};

type CaseSelectionErrorCode = 'invalid_selection' | 'case_not_found' | 'no_matching_cases';

/** Identifies invalid or empty selections independently of any host or CLI. */
class CaseSelectionError extends AttestError {
  declare readonly code: CaseSelectionErrorCode;
  readonly details: { missing_ids?: string[]; resource_type?: 'case' };

  constructor(
    code: CaseSelectionErrorCode,
    message: string,
    details: CaseSelectionError['details'] = {},
  ) {
    super(code, message);
    this.details = details;
  }
}

/** One predicate per filter the selection sets; unset filters match everything. */
const selectionFilters = (
  selection: CaseSelection,
): Array<(candidate: SelectableCase) => boolean> => {
  const filters: Array<(candidate: SelectableCase) => boolean> = [];
  const { case_ids: caseIds, tags, folders, dataset_ids: datasetIds } = selection;
  if (caseIds !== undefined) filters.push(({ case: testCase }) => caseIds.includes(testCase.id));
  if (tags !== undefined) {
    filters.push(({ case: testCase }) => tags.every((tag) => testCase.tags?.includes(tag)));
  }
  if (folders !== undefined) {
    // Folder filters match whole path segments, so `billing` never matches `billing-other`.
    filters.push(({ case: testCase }) =>
      folders.some(
        (folder) => testCase.folder === folder || testCase.folder?.startsWith(`${folder}/`),
      ),
    );
  }
  if (datasetIds !== undefined) {
    filters.push(
      ({ source }) => source.kind === 'dataset' && datasetIds.includes(source.dataset_id),
    );
  }
  return filters;
};

const identity = (candidate: SelectableCase): string =>
  JSON.stringify([candidate.test_id, candidate.case.id]);

/**
 * Applies case, tag, folder, and dataset filters, then samples by seeded hash rank so the same
 * seed selects the same cases on any host. Selected cases keep their configured order. The
 * selection is assumed to be validated by `caseSelectionSchema`.
 */
const selectCases = <T extends SelectableCase>(
  candidates: readonly T[],
  selection: CaseSelection = {},
): { cases: T[]; summary: CaseSelectionSummary } => {
  const identities = candidates.map(identity);
  if (new Set(identities).size !== identities.length) {
    throw new CaseSelectionError(
      'invalid_selection',
      'Duplicate case identities in the selection population.',
    );
  }
  for (const values of [
    selection.case_ids,
    selection.tags,
    selection.folders,
    selection.dataset_ids,
  ]) {
    if (values !== undefined && new Set(values).size !== values.length) {
      throw new CaseSelectionError(
        'invalid_selection',
        'Duplicate selection values are not allowed.',
      );
    }
  }
  const availableIds = new Set(candidates.map(({ case: testCase }) => testCase.id));
  const missing = selection.case_ids?.filter((id) => !availableIds.has(id)) ?? [];
  if (missing.length > 0) {
    throw new CaseSelectionError(
      'case_not_found',
      `Selected case ids do not exist: ${missing.join(', ')}.`,
      { missing_ids: missing, resource_type: 'case' },
    );
  }
  const matched = candidates.filter((candidate) =>
    selectionFilters(selection).every((matches) => matches(candidate)),
  );
  if (matched.length === 0)
    throw new CaseSelectionError('no_matching_cases', 'No cases matched the eval selection.');
  let cases = matched;
  let sample: CaseSelectionSummary['sample'];
  if (selection.sample !== undefined) {
    const { count } = selection.sample;
    sample = { count, seed: selection.sample.seed ?? randomUUID(), algorithm: 'hash-rank-v1' };
    const seed = sample.seed;
    const ranked = matched
      .map((candidate) => ({
        key: identity(candidate),
        rank: createHash('sha256')
          .update(JSON.stringify(['hash-rank-v1', seed, candidate.test_id, candidate.case.id]))
          .digest('hex'),
      }))
      .sort((a, b) => a.rank.localeCompare(b.rank) || a.key.localeCompare(b.key));
    const selected = new Set(ranked.slice(0, count).map(({ key }) => key));
    cases = matched.filter((candidate) => selected.has(identity(candidate)));
  }
  return {
    cases,
    summary: {
      total_cases: candidates.length,
      matched_cases: matched.length,
      selected_cases: cases.length,
      ...(sample === undefined ? {} : { sample }),
    },
  };
};

export { CaseSelectionError, selectCases, type SelectableCase };
