import { createHash, randomUUID } from 'node:crypto';
import {
  AttestError,
  type CaseSelection,
  type CaseSelectionSummary,
  type EvalRunSelectedCase,
} from '@attest/contracts';

type SelectableCase = {
  test_id: string;
  case: { id: string; tags?: readonly string[]; folder?: string };
  source: EvalRunSelectedCase['source'];
};

/** Identifies invalid or empty selections independently of any host or CLI. */
class CaseSelectionError extends AttestError {
  readonly code: 'invalid_selection' | 'case_not_found' | 'no_matching_cases';
  readonly details: { missing_ids?: string[]; resource_type?: 'case' };

  constructor(
    code: CaseSelectionError['code'],
    message: string,
    details: CaseSelectionError['details'] = {},
  ) {
    super(code, message);
    this.code = code;
    this.details = details;
  }
}

const identity = (candidate: SelectableCase): string =>
  JSON.stringify([candidate.test_id, candidate.case.id]);

/** Selects cases without mutation, retaining input order after seeded sampling without replacement. */
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
  const matched = candidates.filter((candidate) => {
    const testCase = candidate.case;
    return (
      (selection.case_ids === undefined || selection.case_ids.includes(testCase.id)) &&
      (selection.tags === undefined ||
        selection.tags.every((tag) => testCase.tags?.includes(tag))) &&
      (selection.folders === undefined ||
        selection.folders.some(
          (folder) => testCase.folder === folder || testCase.folder?.startsWith(`${folder}/`),
        )) &&
      (selection.dataset_ids === undefined ||
        (candidate.source.kind === 'dataset' &&
          selection.dataset_ids.includes(candidate.source.dataset_id)))
    );
  });
  if (matched.length === 0)
    throw new CaseSelectionError('no_matching_cases', 'No cases matched the eval selection.');
  let cases = matched;
  let sample: CaseSelectionSummary['sample'];
  if (selection.sample !== undefined) {
    const { count } = selection.sample;
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new CaseSelectionError(
        'invalid_selection',
        'Sample count must be a positive safe integer.',
      );
    }
    sample = { count, seed: selection.sample.seed ?? randomUUID(), algorithm: 'hash-rank-v1' };
    const seed = sample.seed;
    const ranked = matched
      .map((candidate) => ({
        key: identity(candidate),
        rank: createHash('sha256')
          .update(JSON.stringify(['hash-rank-v1', seed, candidate.test_id, candidate.case.id]))
          .digest('hex'),
      }))
      .sort((a, b) =>
        a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
      );
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

export { selectCases, CaseSelectionError, type SelectableCase };
