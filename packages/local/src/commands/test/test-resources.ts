import {
  type CommandRequest,
  type ProjectResources,
  type TestCase,
  type TestResource,
} from '@attest/contracts';
import { createContentCaseId, type ImportCollisionContext } from '@attest/core';

import { LocalError } from '../../errors/index.js';

const MISSING_RESOURCE_HINTS = {
  case: 'Run `attest test case list <test-id>` to inspect direct case ids.',
  dataset: 'Run `attest list datasets` to inspect available ids.',
  test: 'Run `attest list tests` to inspect available ids.',
} as const;

const missingResource = (type: keyof typeof MISSING_RESOURCE_HINTS, id: string): LocalError =>
  new LocalError('resource_not_found', `${type} ${id} was not found.`, {
    path: id,
    hint: MISSING_RESOURCE_HINTS[type],
  });

const findTest = (candidate: ProjectResources, id: string): TestResource => {
  const test = candidate.tests.find((item) => item.id === id);
  if (test === undefined) throw missingResource('test', id);
  return test;
};

const findDataset = (candidate: ProjectResources, id: string) => {
  const dataset = candidate.datasets.find(({ metadata }) => metadata.id === id);
  if (dataset === undefined) throw missingResource('dataset', id);
  return dataset;
};

const assertNewResourceId = (
  values: readonly { id: string }[],
  type: 'dataset' | 'test',
  id: string,
): void => {
  if (values.some((value) => value.id === id)) {
    throw new LocalError('project_invalid', `${type} ${id} already exists.`, {
      path: id,
      hint: `Choose a new ${type} id.`,
    });
  }
};

const caseWithGeneratedId = (
  value: Extract<CommandRequest, { command: 'test.case.add' }>['case'],
): TestCase => ({ ...value, id: value.id ?? createContentCaseId(value) });

const attachedDatasetTests = (candidate: ProjectResources, datasetId: string): string[] =>
  candidate.tests
    .filter((test) => test.datasets.some(({ dataset_id }) => dataset_id === datasetId))
    .map(({ id }) => id)
    .sort();

const attachmentCases = (
  candidate: ProjectResources,
  test: TestResource,
  excludedDatasetId?: string,
): TestCase[] =>
  test.datasets.flatMap((attachment) => {
    if (attachment.dataset_id === excludedDatasetId) return [];
    const dataset = findDataset(candidate, attachment.dataset_id);
    return dataset.cases.filter((testCase) => {
      const tags = new Set(testCase.tags ?? []);
      return attachment.tags?.some((tag) => !tags.has(tag)) !== true;
    });
  });

/** Collects direct/attached cases that an imported dataset must not collide with in any test. */
const datasetImportCollisionContexts = (
  candidate: ProjectResources,
  datasetId: string,
  importingTestId: string,
): ImportCollisionContext[] =>
  candidate.tests
    .filter(
      (test) =>
        test.id === importingTestId ||
        test.datasets.some((attachment) => attachment.dataset_id === datasetId),
    )
    .map((test) => {
      const targetAttachment = test.datasets.find(
        (attachment) => attachment.dataset_id === datasetId,
      );
      return {
        cases: [...test.cases, ...attachmentCases(candidate, test, datasetId)],
        ...(targetAttachment?.tags === undefined ? {} : { requiredTags: targetAttachment.tags }),
      };
    });

/** Rejects dataset removal with copy-paste detach commands for every blocking test. */
const assertDatasetRemovable = (candidate: ProjectResources, datasetId: string): void => {
  findDataset(candidate, datasetId);
  const references = attachedDatasetTests(candidate, datasetId);
  if (references.length === 0) return;
  const detachCommands = references.map(
    (testId) => `attest test dataset detach ${testId} ${datasetId}`,
  );
  throw new LocalError('project_invalid', 'Attached datasets cannot be removed.', {
    path: datasetId,
    hint: `Run ${detachCommands.map((command) => `\`${command}\``).join(', ')}, then retry.`,
    details: { attached_tests: references, detach_commands: detachCommands },
  });
};

export {
  assertDatasetRemovable,
  assertNewResourceId,
  attachedDatasetTests,
  attachmentCases,
  caseWithGeneratedId,
  datasetImportCollisionContexts,
  findDataset,
  findTest,
  missingResource,
};
