import * as Effect from 'effect/Effect';
import type {
  CommandResult,
  TestCaseListResult,
  TestCaseShowResult,
} from '../shared/command-result.js';
import { runListCommand } from '../list/list-command.js';
import { loadCommandProject } from '../project/load-command-project.js';
import { runShowCommand } from '../show/show-command.js';

import { findResource, missingResource } from '../shared/resource-lookup.js';
import { assertDatasetRemovable } from './test-resources.js';

type TestReadCommandOptions = {
  caseId?: string;
  project?: string;
  testId?: string;
  workingDirectory: string;
};

/** Performs reference validation before a destructive dataset confirmation prompt. */
const runTestDatasetRemovePreflight = Effect.fn('runTestDatasetRemovePreflight')(function* (
  options: TestReadCommandOptions & { datasetId: string },
) {
  const loaded = yield* loadCommandProject(options);

  yield* assertDatasetRemovable(loaded, options.datasetId);
});

/** Lists canonical tests using the same deterministic summary as the generic read surface. */
const runTestListCommand = Effect.fn('runTestListCommand')(function* (
  options: TestReadCommandOptions,
) {
  return yield* runListCommand({ ...options, resourceType: 'tests' });
});

/** Shows one canonical test using the same validated generic read surface. */
const runTestShowCommand = Effect.fn('runTestShowCommand')(function* (
  options: TestReadCommandOptions & { testId: string },
) {
  return yield* runShowCommand({ ...options, id: options.testId, resourceType: 'test' });
});

/** Lists direct cases only; attached dataset rows remain visible through dataset inspection. */
const runTestCaseListCommand = Effect.fn('runTestCaseListCommand')(function* (
  options: TestReadCommandOptions & { testId: string },
) {
  const loaded = yield* loadCommandProject(options);

  const test = yield* findResource('test', loaded.tests, options.testId);

  const items = test.cases.map(
    ({ id, tags, folder }): TestCaseListResult['items'][number] & { folder?: string } => {
      let assembledFields: TestCaseListResult['items'][number] & { folder?: string } = {
        id,
      };

      if (tags !== undefined) {
        assembledFields = { ...assembledFields, tags: tags };
      }

      if (folder !== undefined) {
        assembledFields.folder = folder;
      }

      return assembledFields;
    },
  );

  return {
    operation: 'test-case-list' as const,
    projectHashBefore: loaded.projectHash,
    projectHashAfter: loaded.projectHash,
    result: { test_id: test.id, items },
  } satisfies CommandResult<'test-case-list', TestCaseListResult>;
});

/** Shows one direct case without resolving or copying attached dataset rows. */
const runTestCaseShowCommand = Effect.fn('runTestCaseShowCommand')(function* (
  options: TestReadCommandOptions & { caseId: string; testId: string },
) {
  const loaded = yield* loadCommandProject(options);

  const test = yield* findResource('test', loaded.tests, options.testId);
  const testCase = test.cases.find(({ id }) => id === options.caseId);

  if (testCase === undefined) return yield* missingResource('case', options.caseId);

  return {
    operation: 'test-case-show' as const,
    projectHashBefore: loaded.projectHash,
    projectHashAfter: loaded.projectHash,
    result: { test_id: test.id, case: testCase },
  } satisfies CommandResult<'test-case-show', TestCaseShowResult>;
});

export {
  runTestCaseListCommand,
  runTestCaseShowCommand,
  runTestDatasetRemovePreflight,
  runTestListCommand,
  runTestShowCommand,
};
