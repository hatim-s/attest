import {
  CASE_SCHEMA_VERSION,
  DATASET_SCHEMA_VERSION,
  type CliWarning,
  type CommandRequest,
  type ProjectResources,
  type TestCase,
  type TestResource,
} from '@attest/contracts';

import { AttestCliError } from '../../errors.js';
import type { JsonValue } from '../../project/canonical-project.js';
import type { LoadedProject } from '../../project/load-project.js';
import {
  applyProjectMutation,
  type ProjectMutationRequest,
  type PublishObserver,
} from '../../project/transaction/index.js';
import type { CommandResult } from '../command-result.js';
import { runListCommand } from '../list/list-command.js';
import { loadCommandProject } from '../project/load-command-project.js';
import { runShowCommand } from '../show/show-command.js';
import { generateCaseId, readNativeCases } from './test-command-input.js';

type TestAuthoringCommand = Extract<
  CommandRequest,
  {
    command:
      | 'test.add'
      | 'test.case.add'
      | 'test.case.import'
      | 'test.case.remove'
      | 'test.case.rename'
      | 'test.dataset.add'
      | 'test.dataset.attach'
      | 'test.dataset.create'
      | 'test.dataset.detach'
      | 'test.dataset.import'
      | 'test.dataset.remove'
      | 'test.dataset.rename'
      | 'test.remove'
      | 'test.rename';
  }
>;

type TestMutationCommandOptions = {
  clock?: () => Date;
  project?: string;
  publishObserver?: PublishObserver;
  readStdin: () => Promise<string>;
  request: TestAuthoringCommand;
  workingDirectory: string;
};

type TestReadCommandOptions = {
  caseId?: string;
  project?: string;
  testId?: string;
  workingDirectory: string;
};

type MutationBuildResult = {
  candidate: ProjectResources;
  importedCaseCount?: number;
  renames?: ProjectMutationRequest['renames'];
  resource: { id: string; type: 'dataset' | 'test' | 'test_case' };
  warnings?: CliWarning[];
};

const candidateFromLoadedProject = (loaded: LoadedProject): ProjectResources =>
  structuredClone({
    agents: loaded.agents,
    datasets: loaded.datasets,
    metrics: loaded.metrics,
    project: loaded.project,
    tests: loaded.tests,
  });

const missingResource = (type: 'case' | 'dataset' | 'test', id: string): AttestCliError =>
  new AttestCliError('resource_not_found', `${type} ${id} was not found.`, {
    path: id,
    hint:
      type === 'case'
        ? 'Run `attest test case list <test-id>` to inspect direct case ids.'
        : `Run \`attest ${type} list\` to inspect available ids.`,
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
    throw new AttestCliError('project_invalid', `${type} ${id} already exists.`, {
      path: id,
      hint: `Choose a new ${type} id.`,
    });
  }
};

const assertNativeImportContract = (
  request: Extract<TestAuthoringCommand, { command: 'test.case.import' | 'test.dataset.import' }>,
): void => {
  const options = request.import;
  const unsupported = [
    ...(options.mapping.length === 0 ? [] : ['mapping']),
    ...(options.parse_json === undefined ? [] : ['parse_json']),
    ...(options.key === undefined ? [] : ['key']),
    ...(options.dedupe === undefined ? [] : ['dedupe']),
    ...(options.on_conflict === undefined ? [] : ['on_conflict']),
    ...(options.sync === 'append' ? [] : ['sync']),
    ...(options.records_pointer === undefined ? [] : ['records_pointer']),
  ];
  if (options.format === 'csv') unsupported.push('format');
  if (unsupported.length > 0) {
    throw new AttestCliError(
      'cli_usage',
      'CLI2.7 accepts native JSON/JSONL cases without mapping or sync policies.',
      {
        path: '/import',
        hint: 'Remove tabular mapping/dedupe options; the generalized importer lands separately.',
        details: { unsupported_fields: unsupported.sort() },
      },
    );
  }
};

const caseWithGeneratedId = (
  value: Extract<TestAuthoringCommand, { command: 'test.case.add' }>['case'],
): TestCase => ({ ...value, id: value.id ?? generateCaseId(value) });

/** Builds the complete candidate for one test/case/dataset command before any write occurs. */
const buildMutation = async (
  loaded: LoadedProject,
  request: TestAuthoringCommand,
  options: TestMutationCommandOptions,
): Promise<MutationBuildResult> => {
  const candidate = candidateFromLoadedProject(loaded);
  switch (request.command) {
    case 'test.add': {
      assertNewResourceId(candidate.tests, 'test', request.test.id);
      candidate.tests.push(request.test);
      return { candidate, resource: { id: request.test.id, type: 'test' } };
    }
    case 'test.rename': {
      const test = findTest(candidate, request.test_id);
      assertNewResourceId(candidate.tests, 'test', request.new_id);
      test.id = request.new_id;
      return {
        candidate,
        renames: [{ from: request.test_id, to: request.new_id, type: 'test' }],
        resource: { id: request.new_id, type: 'test' },
      };
    }
    case 'test.remove': {
      findTest(candidate, request.test_id);
      candidate.tests = candidate.tests.filter(({ id }) => id !== request.test_id);
      return { candidate, resource: { id: request.test_id, type: 'test' } };
    }
    case 'test.case.add': {
      const test = findTest(candidate, request.test_id);
      const testCase = caseWithGeneratedId(request.case);
      test.cases.push(testCase);
      return { candidate, resource: { id: testCase.id, type: 'test_case' } };
    }
    case 'test.case.import': {
      assertNativeImportContract(request);
      const test = findTest(candidate, request.test_id);
      const imported = await readNativeCases({
        format: request.import.format,
        readStdin: options.readStdin,
        source: request.source,
        workingDirectory: options.workingDirectory,
      });
      test.cases.push(...imported.cases);
      const warnings: CliWarning[] =
        imported.cases.length > 100
          ? [
              {
                code: 'direct_case_count_high',
                message: 'More than 100 direct cases were imported; prefer an attached dataset.',
              },
            ]
          : [];
      return {
        candidate,
        importedCaseCount: imported.cases.length,
        resource: { id: request.test_id, type: 'test' },
        warnings,
      };
    }
    case 'test.case.rename': {
      const test = findTest(candidate, request.test_id);
      const testCase = test.cases.find(({ id }) => id === request.case_id);
      if (testCase === undefined) throw missingResource('case', request.case_id);
      testCase.id = request.new_id;
      return { candidate, resource: { id: request.new_id, type: 'test_case' } };
    }
    case 'test.case.remove': {
      const test = findTest(candidate, request.test_id);
      if (!test.cases.some(({ id }) => id === request.case_id)) {
        throw missingResource('case', request.case_id);
      }
      test.cases = test.cases.filter(({ id }) => id !== request.case_id);
      return { candidate, resource: { id: request.case_id, type: 'test_case' } };
    }
    case 'test.dataset.add':
    case 'test.dataset.create': {
      const test = findTest(candidate, request.test_id);
      assertNewResourceId(
        candidate.datasets.map(({ metadata }) => metadata),
        'dataset',
        request.dataset.id,
      );
      if (request.dataset.case_count !== 0) {
        throw new AttestCliError('cli_usage', 'A newly created dataset must be empty.', {
          path: '/dataset/case_count',
          hint: 'Set `case_count` to 0 or use `test dataset import`.',
        });
      }
      candidate.datasets.push({ cases: [], metadata: request.dataset });
      test.datasets.push({ dataset_id: request.dataset.id });
      return { candidate, resource: { id: request.dataset.id, type: 'dataset' } };
    }
    case 'test.dataset.import': {
      assertNativeImportContract(request);
      const test = findTest(candidate, request.test_id);
      assertNewResourceId(
        candidate.datasets.map(({ metadata }) => metadata),
        'dataset',
        request.as,
      );
      const imported = await readNativeCases({
        format: request.import.format,
        readStdin: options.readStdin,
        source: request.source,
        workingDirectory: options.workingDirectory,
      });
      candidate.datasets.push({
        cases: imported.cases,
        metadata: {
          schema: DATASET_SCHEMA_VERSION,
          case_schema: CASE_SCHEMA_VERSION,
          id: request.as,
          name: request.name ?? request.as,
          case_count: imported.cases.length,
          provenance: {
            source_type: imported.format,
            mapping: [],
            imported_at: (options.clock ?? (() => new Date()))().toISOString(),
            source_content_hash: imported.sourceHash,
            counts: {
              read: imported.cases.length,
              inserted: imported.cases.length,
              updated: 0,
              skipped: 0,
            },
          },
        },
      });
      test.datasets.push({ dataset_id: request.as });
      return {
        candidate,
        importedCaseCount: imported.cases.length,
        resource: { id: request.as, type: 'dataset' },
      };
    }
    case 'test.dataset.attach': {
      const test = findTest(candidate, request.test_id);
      findDataset(candidate, request.dataset_id);
      test.datasets.push({
        dataset_id: request.dataset_id,
        ...(request.tags === undefined ? {} : { tags: request.tags }),
      });
      return { candidate, resource: { id: request.dataset_id, type: 'dataset' } };
    }
    case 'test.dataset.detach': {
      const test = findTest(candidate, request.test_id);
      if (!test.datasets.some(({ dataset_id }) => dataset_id === request.dataset_id)) {
        throw missingResource('dataset', request.dataset_id);
      }
      test.datasets = test.datasets.filter(({ dataset_id }) => dataset_id !== request.dataset_id);
      return { candidate, resource: { id: request.dataset_id, type: 'dataset' } };
    }
    case 'test.dataset.rename': {
      const dataset = findDataset(candidate, request.dataset_id);
      assertNewResourceId(
        candidate.datasets.map(({ metadata }) => metadata),
        'dataset',
        request.new_id,
      );
      dataset.metadata.id = request.new_id;
      candidate.tests.forEach((test) =>
        test.datasets.forEach((attachment) => {
          if (attachment.dataset_id === request.dataset_id) attachment.dataset_id = request.new_id;
        }),
      );
      return {
        candidate,
        renames: [{ from: request.dataset_id, to: request.new_id, type: 'dataset' }],
        resource: { id: request.new_id, type: 'dataset' },
      };
    }
    case 'test.dataset.remove': {
      findDataset(candidate, request.dataset_id);
      const references = candidate.tests
        .filter((test) => test.datasets.some(({ dataset_id }) => dataset_id === request.dataset_id))
        .map(({ id }) => id)
        .sort();
      if (references.length > 0) {
        throw new AttestCliError('project_invalid', 'Attached datasets cannot be removed.', {
          path: request.dataset_id,
          hint: 'Detach the dataset from every listed test, then retry.',
          details: { attached_tests: references },
        });
      }
      candidate.datasets = candidate.datasets.filter(
        ({ metadata }) => metadata.id !== request.dataset_id,
      );
      return { candidate, resource: { id: request.dataset_id, type: 'dataset' } };
    }
  }
};

/** Executes one normalized authoring request through the shared hash-guarded transaction writer. */
const runTestMutationCommand = async (
  options: TestMutationCommandOptions,
): Promise<CommandResult> => {
  const loaded = await loadCommandProject({
    project: options.project,
    workingDirectory: options.workingDirectory,
  });
  const built = await buildMutation(loaded, options.request, options);
  const mutation = await applyProjectMutation(
    {
      candidate: built.candidate,
      dryRun: options.request.dry_run,
      expectedProjectHash: options.request.if_project_hash,
      projectRoot: loaded.root,
      renames: built.renames,
      warnings: built.warnings?.map(({ message }) => message),
    },
    { publishObserver: options.publishObserver },
  );
  const dryRun = options.request.dry_run === true;
  const verb = dryRun ? 'would update' : 'updated';
  return {
    human: `${dryRun ? 'Dry run: ' : ''}${verb} ${built.resource.type} ${built.resource.id}.\nProject hash: ${mutation.projectHashAfter}`,
    projectHashBefore: mutation.projectHashBefore,
    projectHashAfter: mutation.projectHashAfter,
    result: {
      committed: mutation.committed,
      dry_run: dryRun,
      resource: built.resource,
      operations: mutation.diff.operations as unknown as JsonValue,
      ...(built.importedCaseCount === undefined
        ? {}
        : { imported_case_count: built.importedCaseCount }),
    },
    warnings: built.warnings,
  };
};

/** Lists canonical tests using the same deterministic summary as the generic read surface. */
const runTestListCommand = async (options: TestReadCommandOptions): Promise<CommandResult> =>
  runListCommand({ ...options, resourceType: 'tests' });

/** Shows one canonical test using the same validated generic read surface. */
const runTestShowCommand = async (
  options: TestReadCommandOptions & { testId: string },
): Promise<CommandResult> =>
  runShowCommand({ ...options, id: options.testId, resourceType: 'test' });

/** Lists direct cases only; attached dataset rows remain visible through dataset inspection. */
const runTestCaseListCommand = async (
  options: TestReadCommandOptions & { testId: string },
): Promise<CommandResult> => {
  const loaded = await loadCommandProject(options);
  const test = findTest(loaded, options.testId);
  const items = test.cases.map(({ id, tags }) => ({ id, ...(tags === undefined ? {} : { tags }) }));
  return {
    human: items.length === 0 ? 'No direct cases.' : items.map(({ id }) => `  ${id}`).join('\n'),
    projectHashBefore: loaded.projectHash,
    projectHashAfter: loaded.projectHash,
    result: { test_id: test.id, items },
  };
};

/** Shows one direct case without resolving or copying attached dataset rows. */
const runTestCaseShowCommand = async (
  options: TestReadCommandOptions & { caseId: string; testId: string },
): Promise<CommandResult> => {
  const loaded = await loadCommandProject(options);
  const test = findTest(loaded, options.testId);
  const testCase = test.cases.find(({ id }) => id === options.caseId);
  if (testCase === undefined) throw missingResource('case', options.caseId);
  return {
    human: JSON.stringify(testCase, undefined, 2),
    projectHashBefore: loaded.projectHash,
    projectHashAfter: loaded.projectHash,
    result: { test_id: test.id, case: testCase as JsonValue },
  };
};

export {
  runTestCaseListCommand,
  runTestCaseShowCommand,
  runTestListCommand,
  runTestMutationCommand,
  runTestShowCommand,
  type TestAuthoringCommand,
  type TestMutationCommandOptions,
  type TestReadCommandOptions,
};
