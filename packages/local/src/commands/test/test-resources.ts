import {
  type CommandRequest,
  type ProjectResources,
  type TestCase,
  type TestResource,
} from '@attest/contracts';
import { createContentCaseId, type ImportCollisionContext } from '@attest/core';

import { LocalError } from '../../errors/index.js';
import { missingResource } from '../shared/resource-lookup.js';

const findDataset = (candidate: ProjectResources, id: string) => {
  const dataset = candidate.datasets.find(({ metadata }) => metadata.id === id);

  if (dataset === undefined) throw missingResource('dataset', id);

  return dataset;
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
    .map((test): ImportCollisionContext => {
      const targetAttachment = test.datasets.find(
        (attachment) => attachment.dataset_id === datasetId,
      );

      {
        const assembledFields: ImportCollisionContext = {
          cases: [...test.cases, ...attachmentCases(candidate, test, datasetId)],
        };

        if (!(targetAttachment?.tags === undefined)) {
          assembledFields.requiredTags = targetAttachment.tags;
        }

        return assembledFields;
      }
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
  attachedDatasetTests,
  attachmentCases,
  caseWithGeneratedId,
  datasetImportCollisionContexts,
  findDataset,
};
