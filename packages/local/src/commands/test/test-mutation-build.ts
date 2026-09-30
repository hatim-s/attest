import {
  CASE_SCHEMA_ID,
  DATASET_SCHEMA_ID,
  type CliWarning,
  type CommandRequest,
  type ProjectResources,
} from '@attest/contracts';
import { type TabularImportResult } from '@attest/core';

import { LocalError } from '../../errors/index.js';
import { type LoadedProject } from '../../project/project-loader/index.js';
import type { ProjectMutationRequest } from '../../project/transaction/index.js';
import { candidateFromLoadedProject } from '../project/load-command-project.js';
import { runTabularImportAdapter } from './import/tabular-import-adapter.js';
import {
  assertDatasetRemovable,
  assertNewResourceId,
  attachedDatasetTests,
  attachmentCases,
  caseWithGeneratedId,
  datasetImportCollisionContexts,
  findDataset,
  findTest,
  missingResource,
} from './test-resources.js';

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
      | 'test.dataset.detach'
      | 'test.dataset.import'
      | 'test.dataset.remove'
      | 'test.dataset.rename'
      | 'test.remove'
      | 'test.rename';
  }
>;

type TestMutationCommandOptions = {
  project?: string;
  preparedImportSource?: Uint8Array;
  readImportStdin: () => AsyncIterable<string | Uint8Array>;
  readStdin: () => Promise<string>;
  request: TestAuthoringCommand;
  workingDirectory: string;
};

type MutationBuildResult = {
  affectedTests?: string[];
  candidate: ProjectResources;
  importResult?: TabularImportResult;
  importedCaseCount?: number;
  renames?: ProjectMutationRequest['renames'];
  resource: { id: string; type: 'dataset' | 'test' | 'test_case' };
  warnings?: CliWarning[];
};

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
      const test = findTest(candidate, request.test_id);
      const imported = await runTabularImportAdapter({
        // Cases outside the direct import target that already resolve into its test.
        collisionCases: attachmentCases(candidate, test),
        existingCases: test.cases,
        importOptions: request.import,
        preparedSource: options.preparedImportSource,
        readImportStdin: options.readImportStdin,
        source: request.source,
        workingDirectory: options.workingDirectory,
      });
      test.cases = imported.cases;
      const warnings: CliWarning[] =
        imported.counts.read > 100
          ? [
              {
                code: 'direct_case_count_high',
                message: 'More than 100 direct cases were imported; prefer an attached dataset.',
              },
            ]
          : [];
      return {
        candidate,
        importedCaseCount: imported.counts.inserted + imported.counts.updated,
        importResult: imported,
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
    case 'test.dataset.add': {
      const test = findTest(candidate, request.test_id);
      assertNewResourceId(
        candidate.datasets.map(({ metadata }) => metadata),
        'dataset',
        request.dataset.id,
      );
      candidate.datasets.push({ cases: [], metadata: request.dataset });
      test.datasets.push({ dataset_id: request.dataset.id });
      return { candidate, resource: { id: request.dataset.id, type: 'dataset' } };
    }
    case 'test.dataset.import': {
      const test = findTest(candidate, request.test_id);
      const existing = candidate.datasets.find(({ metadata }) => metadata.id === request.as);
      const affectedTests = attachedDatasetTests(candidate, request.as);
      const consumerTests = [...new Set([...affectedTests, request.test_id])].sort();
      if (existing !== undefined && request.import.sync !== 'upsert') {
        throw new LocalError(
          'project_invalid',
          `Dataset ${request.as} already exists; import will not silently replace it.`,
          {
            path: '--sync',
            hint: 'Pass --sync upsert to select explicit dataset update semantics.',
            details: { affected_tests: consumerTests },
          },
        );
      }
      if (
        existing !== undefined &&
        affectedTests.some((id) => id !== request.test_id) &&
        request.dry_run !== true &&
        request.yes !== true
      ) {
        throw new LocalError('cli_missing_input', 'Shared dataset updates require confirmation.', {
          path: '--yes',
          hint: 'Preview with --dry-run, then pass --yes to update every affected test.',
          details: { affected_tests: consumerTests },
        });
      }
      const imported = await runTabularImportAdapter({
        collisionContexts: datasetImportCollisionContexts(candidate, request.as, request.test_id),
        existingCases: existing?.cases,
        importOptions: request.import,
        preparedSource: options.preparedImportSource,
        readImportStdin: options.readImportStdin,
        source: request.source,
        workingDirectory: options.workingDirectory,
      });
      const importedDataset = {
        cases: imported.cases,
        metadata: {
          schema: DATASET_SCHEMA_ID,
          case_schema: CASE_SCHEMA_ID,
          id: request.as,
          name: request.name ?? existing?.metadata.name ?? request.as,
          case_count: imported.cases.length,
          provenance: {
            source_type: imported.format,
            mapping: request.import.mapping ?? [],
            ...(request.import.key === undefined ? {} : { key_field: request.import.key }),
            imported_at: new Date().toISOString(),
            source_content_hash: imported.sourceHash,
            counts: imported.counts,
          },
        },
      };
      if (existing === undefined) candidate.datasets.push(importedDataset);
      else Object.assign(existing, importedDataset);
      if (!test.datasets.some(({ dataset_id }) => dataset_id === request.as)) {
        test.datasets.push({ dataset_id: request.as });
      }
      return {
        ...(existing !== undefined && consumerTests.length > 1
          ? { affectedTests: consumerTests }
          : {}),
        candidate,
        importedCaseCount: imported.counts.inserted + imported.counts.updated,
        importResult: imported,
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
      assertDatasetRemovable(candidate, request.dataset_id);
      candidate.datasets = candidate.datasets.filter(
        ({ metadata }) => metadata.id !== request.dataset_id,
      );
      return { candidate, resource: { id: request.dataset_id, type: 'dataset' } };
    }
  }
};

export { buildMutation, type TestAuthoringCommand, type TestMutationCommandOptions };
