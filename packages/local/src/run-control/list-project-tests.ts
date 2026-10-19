import { expandTestCases } from '@attest/core';
import type { TestSummary } from '@attest/core/records';

import { loadCommandProject } from '../commands/project/load-command-project.js';

/**
 * Lists the project's tests the way a run would resolve them: dataset rows count as cases and
 * their tags are offered for filtering. Loads through the same path as `attest test list`.
 */
const listProjectTests = async (projectRoot: string): Promise<TestSummary[]> => {
  const project = await loadCommandProject({ project: projectRoot, workingDirectory: projectRoot });
  const datasetsById = new Map(project.datasets.map((dataset) => [dataset.metadata.id, dataset]));

  return project.tests.map((test) => {
    const cases = expandTestCases(test, datasetsById);
    const tags = new Set(cases.flatMap(({ case: testCase }) => testCase.tags ?? []));

    return { id: test.id, name: test.name, tags: [...tags].sort(), caseCount: cases.length };
  });
};

export { listProjectTests };
