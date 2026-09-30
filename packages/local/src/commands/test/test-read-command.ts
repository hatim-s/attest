import type {
  CommandResult,
  ResourceListResult,
  ResourceShowResult,
  TestCaseListResult,
  TestCaseShowResult,
} from '../shared/command-result.js';
import { runListCommand } from '../list/list-command.js';
import { loadCommandProject } from '../project/load-command-project.js';
import { runShowCommand } from '../show/show-command.js';

import { assertDatasetRemovable, findTest, missingResource } from './test-resources.js';

type TestReadCommandOptions = {
  caseId?: string;
  project?: string;
  testId?: string;
  workingDirectory: string;
};

/** Performs reference validation before a destructive dataset confirmation prompt. */
const runTestDatasetRemovePreflight = async (
  options: TestReadCommandOptions & { datasetId: string },
): Promise<void> => {
  const loaded = await loadCommandProject(options);
  assertDatasetRemovable(loaded, options.datasetId);
};

/** Lists canonical tests using the same deterministic summary as the generic read surface. */
const runTestListCommand = async (
  options: TestReadCommandOptions,
): Promise<CommandResult<'list', ResourceListResult>> =>
  runListCommand({ ...options, resourceType: 'tests' });

/** Shows one canonical test using the same validated generic read surface. */
const runTestShowCommand = async (
  options: TestReadCommandOptions & { testId: string },
): Promise<CommandResult<'show', ResourceShowResult>> =>
  runShowCommand({ ...options, id: options.testId, resourceType: 'test' });

/** Lists direct cases only; attached dataset rows remain visible through dataset inspection. */
const runTestCaseListCommand = async (
  options: TestReadCommandOptions & { testId: string },
): Promise<CommandResult<'test-case-list', TestCaseListResult>> => {
  const loaded = await loadCommandProject(options);
  const test = findTest(loaded, options.testId);
  const items = test.cases.map(({ id, tags, folder }) => ({
    id,
    ...(tags === undefined ? {} : { tags }),
    ...(folder === undefined ? {} : { folder }),
  }));
  return {
    operation: 'test-case-list',
    projectHashBefore: loaded.projectHash,
    projectHashAfter: loaded.projectHash,
    result: { test_id: test.id, items },
  };
};

/** Shows one direct case without resolving or copying attached dataset rows. */
const runTestCaseShowCommand = async (
  options: TestReadCommandOptions & { caseId: string; testId: string },
): Promise<CommandResult<'test-case-show', TestCaseShowResult>> => {
  const loaded = await loadCommandProject(options);
  const test = findTest(loaded, options.testId);
  const testCase = test.cases.find(({ id }) => id === options.caseId);
  if (testCase === undefined) throw missingResource('case', options.caseId);
  return {
    operation: 'test-case-show',
    projectHashBefore: loaded.projectHash,
    projectHashAfter: loaded.projectHash,
    result: { test_id: test.id, case: testCase },
  };
};

export {
  runTestCaseListCommand,
  runTestCaseShowCommand,
  runTestDatasetRemovePreflight,
  runTestListCommand,
  runTestShowCommand,
};
