import {
  type CommandRequest,
  type ProjectResources,
  type TestCase,
  type TestResource,
} from '@attest/contracts';
import { createContentCaseId, type ImportCollisionContext } from '@attest/core';
import * as Effect from 'effect/Effect';

import { LocalError } from '../../errors/index.js';
import { missingResource } from '../shared/resource-lookup.js';

const findDataset = Effect.fn('findDataset')(function* (candidate: ProjectResources, id: string) {
  const dataset = candidate.datasets.find(({ metadata }) => metadata.id === id);

  if (dataset === undefined) return yield* missingResource('dataset', id);

  return dataset;
});

const caseWithGeneratedId = (
  value: Extract<CommandRequest, { command: 'test.case.add' }>['case'],
): TestCase => ({ ...value, id: value.id ?? createContentCaseId(value) });

const attachedDatasetTests = (candidate: ProjectResources, datasetId: string): string[] =>
  candidate.tests
    .filter((test) => test.datasets.some(({ dataset_id }) => dataset_id === datasetId))
    .map(({ id }) => id)
    .sort();

const attachmentCases = Effect.fn('attachmentCases')(function* (
  candidate: ProjectResources,
  test: TestResource,
  excludedDatasetId?: string,
) {
  const cases: TestCase[] = [];

  for (const attachment of test.datasets) {
    if (attachment.dataset_id === excludedDatasetId) continue;
    const dataset = yield* findDataset(candidate, attachment.dataset_id);

    cases.push(
      ...dataset.cases.filter((testCase) => {
        const tags = new Set(testCase.tags ?? []);

        return attachment.tags?.some((tag) => !tags.has(tag)) !== true;
      }),
    );
  }

  return cases;
});

/** Collects direct/attached cases that an imported dataset must not collide with in any test. */
const datasetImportCollisionContexts = Effect.fn('datasetImportCollisionContexts')(function* (
  candidate: ProjectResources,
  datasetId: string,
  importingTestId: string,
) {
  const contexts: ImportCollisionContext[] = [];

  for (const test of candidate.tests) {
    const usesDataset = test.datasets.some((attachment) => attachment.dataset_id === datasetId);

    if (test.id === importingTestId || usesDataset) {
      const targetAttachment = test.datasets.find(
        (attachment) => attachment.dataset_id === datasetId,
      );

      const attachedCases = yield* attachmentCases(candidate, test, datasetId);

      const assembledFields: ImportCollisionContext = {
        cases: [...test.cases, ...attachedCases],
      };

      if (targetAttachment?.tags !== undefined) {
        assembledFields.requiredTags = targetAttachment.tags;
      }

      contexts.push(assembledFields);
    }
  }

  return contexts;
});

/** Rejects dataset removal with copy-paste detach commands for every blocking test. */
const assertDatasetRemovable = Effect.fn('assertDatasetRemovable')(function* (
  candidate: ProjectResources,
  datasetId: string,
) {
  yield* findDataset(candidate, datasetId);
  const references = attachedDatasetTests(candidate, datasetId);

  if (references.length === 0) return;

  const detachCommands = references.map(
    (testId) => `attest test dataset detach ${testId} ${datasetId}`,
  );

  return yield* new LocalError('project_invalid', 'Attached datasets cannot be removed.', {
    path: datasetId,
    hint: `Run ${detachCommands.map((command) => `\`${command}\``).join(', ')}, then retry.`,
    details: { attached_tests: references, detach_commands: detachCommands },
  });
});

export {
  assertDatasetRemovable,
  attachedDatasetTests,
  attachmentCases,
  caseWithGeneratedId,
  datasetImportCollisionContexts,
  findDataset,
};
