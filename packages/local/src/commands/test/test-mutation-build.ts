import * as Effect from 'effect/Effect';
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
import { assertNewId, findResource, missingResource } from '../shared/resource-lookup.js';
import { runTabularImportAdapter } from './import/tabular-import-adapter.js';
import {
  assertDatasetRemovable,
  attachedDatasetTests,
  attachmentCases,
  caseWithGeneratedId,
  datasetImportCollisionContexts,
  findDataset,
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

/** Replaces an existing test after a command updates its cases or dataset attachments. */
const replaceTest = (candidate: ProjectResources, test: ProjectResources['tests'][number]) => ({
  ...candidate,
  tests: candidate.tests.map((entry) => (entry.id === test.id ? test : entry)),
});

/** Builds the complete candidate for one test/case/dataset command before any write occurs. */
const buildMutation = Effect.fn('buildMutation')(function* (
  loaded: LoadedProject,
  request: TestAuthoringCommand,
  options: TestMutationCommandOptions,
) {
  let candidate = candidateFromLoadedProject(loaded);

  switch (request.command) {
    case 'test.add': {
      yield* assertNewId('test', candidate.tests, request.test.id);
      candidate = { ...candidate, tests: [...candidate.tests, request.test] };

      return {
        candidate,
        resource: { id: request.test.id, type: 'test' as const },
      } satisfies MutationBuildResult;
    }

    case 'test.rename': {
      let test = yield* findResource('test', candidate.tests, request.test_id);
      yield* assertNewId('test', candidate.tests, request.new_id);
      test = { ...test, id: request.new_id };
      candidate = {
        ...candidate,
        tests: candidate.tests.map((entry) => (entry.id === request.test_id ? test : entry)),
      };

      return {
        candidate,
        renames: [{ from: request.test_id, to: request.new_id, type: 'test' as const }],
        resource: { id: request.new_id, type: 'test' as const },
      } satisfies MutationBuildResult;
    }

    case 'test.remove': {
      yield* findResource('test', candidate.tests, request.test_id);
      candidate = {
        ...candidate,
        tests: candidate.tests.filter(({ id }) => id !== request.test_id),
      };

      return {
        candidate,
        resource: { id: request.test_id, type: 'test' as const },
      } satisfies MutationBuildResult;
    }

    case 'test.case.add': {
      let test = yield* findResource('test', candidate.tests, request.test_id);
      const testCase = caseWithGeneratedId(request.case);
      test = { ...test, cases: [...test.cases, testCase] };
      candidate = replaceTest(candidate, test);

      return {
        candidate,
        resource: { id: testCase.id, type: 'test_case' as const },
      } satisfies MutationBuildResult;
    }

    case 'test.case.import': {
      let test = yield* findResource('test', candidate.tests, request.test_id);
      const attachedCases = yield* attachmentCases(candidate, test);

      const imported = yield* runTabularImportAdapter({
        // Cases outside the direct import target that already resolve into its test.
        collisionContexts: [{ cases: attachedCases }],
        existingCases: test.cases,
        importOptions: request.import,
        preparedSource: options.preparedImportSource,
        readImportStdin: options.readImportStdin,
        source: request.source,
        workingDirectory: options.workingDirectory,
      });

      test = { ...test, cases: imported.cases };
      candidate = replaceTest(candidate, test);

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
        resource: { id: request.test_id, type: 'test' as const },
        warnings,
      } satisfies MutationBuildResult;
    }

    case 'test.case.rename': {
      let test = yield* findResource('test', candidate.tests, request.test_id);
      let testCase = test.cases.find(({ id }) => id === request.case_id);

      if (testCase === undefined) return yield* missingResource('case', request.case_id);
      testCase = { ...testCase, id: request.new_id };
      test = {
        ...test,
        cases: test.cases.map((entry) => (entry.id === request.case_id ? testCase : entry)),
      };
      candidate = replaceTest(candidate, test);

      return {
        candidate,
        resource: { id: request.new_id, type: 'test_case' as const },
      } satisfies MutationBuildResult;
    }

    case 'test.case.remove': {
      let test = yield* findResource('test', candidate.tests, request.test_id);

      if (!test.cases.some(({ id }) => id === request.case_id)) {
        return yield* missingResource('case', request.case_id);
      }

      test = { ...test, cases: test.cases.filter(({ id }) => id !== request.case_id) };
      candidate = replaceTest(candidate, test);

      return {
        candidate,
        resource: { id: request.case_id, type: 'test_case' as const },
      } satisfies MutationBuildResult;
    }

    case 'test.dataset.add': {
      let test = yield* findResource('test', candidate.tests, request.test_id);
      yield* assertNewId(
        'dataset',
        candidate.datasets.map(({ metadata }) => metadata),
        request.dataset.id,
      );
      candidate = {
        ...candidate,
        datasets: [...candidate.datasets, { cases: [], metadata: request.dataset }],
      };
      test = { ...test, datasets: [...test.datasets, { dataset_id: request.dataset.id }] };
      candidate = replaceTest(candidate, test);

      return {
        candidate,
        resource: { id: request.dataset.id, type: 'dataset' as const },
      } satisfies MutationBuildResult;
    }

    case 'test.dataset.import': {
      let test = yield* findResource('test', candidate.tests, request.test_id);
      const existing = candidate.datasets.find(({ metadata }) => metadata.id === request.as);
      const affectedTests = attachedDatasetTests(candidate, request.as);
      const consumerTests = [...new Set([...affectedTests, request.test_id])].sort();

      if (existing !== undefined && request.import.sync !== 'upsert') {
        return yield* new LocalError(
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
        return yield* new LocalError(
          'cli_missing_input',
          'Shared dataset updates require confirmation.',
          {
            path: '--yes',
            hint: 'Preview with --dry-run, then pass --yes to update every affected test.',
            details: { affected_tests: consumerTests },
          },
        );
      }

      const collisionContexts = yield* datasetImportCollisionContexts(
        candidate,
        request.as,
        request.test_id,
      );

      const imported = yield* runTabularImportAdapter({
        collisionContexts,
        existingCases: existing?.cases,
        importOptions: request.import,
        preparedSource: options.preparedImportSource,
        readImportStdin: options.readImportStdin,
        source: request.source,
        workingDirectory: options.workingDirectory,
      });

      let provenance: NonNullable<ProjectResources['datasets'][number]['metadata']['provenance']> =
        {
          source_type: imported.format,
          mapping: request.import.mapping ?? [],
          imported_at: new Date().toISOString(),
          source_content_hash: imported.sourceHash,
          counts: imported.counts,
        };

      if (request.import.key !== undefined) {
        provenance = { ...provenance, key_field: request.import.key };
      }

      const importedDataset = {
        cases: imported.cases,
        metadata: {
          schema: DATASET_SCHEMA_ID,
          case_schema: CASE_SCHEMA_ID,
          id: request.as,
          name: request.name ?? existing?.metadata.name ?? request.as,
          case_count: imported.cases.length,
          provenance: provenance,
        },
      };

      if (existing === undefined)
        candidate = { ...candidate, datasets: [...candidate.datasets, importedDataset] };
      else
        candidate = {
          ...candidate,
          datasets: candidate.datasets.map((entry) =>
            entry === existing ? importedDataset : entry,
          ),
        };

      if (!test.datasets.some(({ dataset_id }) => dataset_id === request.as)) {
        test = { ...test, datasets: [...test.datasets, { dataset_id: request.as }] };
        candidate = replaceTest(candidate, test);
      }

      return {
        affectedTests:
          existing !== undefined && consumerTests.length > 1 ? consumerTests : undefined,
        candidate,
        importedCaseCount: imported.counts.inserted + imported.counts.updated,
        importResult: imported,
        resource: { id: request.as, type: 'dataset' as const },
      } satisfies MutationBuildResult;
    }

    case 'test.dataset.attach': {
      let test = yield* findResource('test', candidate.tests, request.test_id);
      yield* findDataset(candidate, request.dataset_id);
      let attachment: (typeof test.datasets)[number] = { dataset_id: request.dataset_id };

      if (request.tags !== undefined) attachment = { ...attachment, tags: request.tags };
      test = { ...test, datasets: [...test.datasets, attachment] };
      candidate = replaceTest(candidate, test);

      return {
        candidate,
        resource: { id: request.dataset_id, type: 'dataset' as const },
      } satisfies MutationBuildResult;
    }

    case 'test.dataset.detach': {
      let test = yield* findResource('test', candidate.tests, request.test_id);

      if (!test.datasets.some(({ dataset_id }) => dataset_id === request.dataset_id)) {
        return yield* missingResource('dataset', request.dataset_id);
      }

      test = {
        ...test,
        datasets: test.datasets.filter(({ dataset_id }) => dataset_id !== request.dataset_id),
      };
      candidate = replaceTest(candidate, test);

      return {
        candidate,
        resource: { id: request.dataset_id, type: 'dataset' as const },
      } satisfies MutationBuildResult;
    }

    case 'test.dataset.rename': {
      let dataset = yield* findDataset(candidate, request.dataset_id);
      yield* assertNewId(
        'dataset',
        candidate.datasets.map(({ metadata }) => metadata),
        request.new_id,
      );
      dataset = { ...dataset, metadata: { ...dataset.metadata, id: request.new_id } };
      candidate = {
        ...candidate,
        datasets: candidate.datasets.map((entry) =>
          entry.metadata.id === request.dataset_id ? dataset : entry,
        ),
        tests: candidate.tests.map((test) => ({
          ...test,
          datasets: test.datasets.map((attachment) =>
            attachment.dataset_id === request.dataset_id
              ? { ...attachment, dataset_id: request.new_id }
              : attachment,
          ),
        })),
      };

      return {
        candidate,
        renames: [{ from: request.dataset_id, to: request.new_id, type: 'dataset' as const }],
        resource: { id: request.new_id, type: 'dataset' as const },
      } satisfies MutationBuildResult;
    }

    case 'test.dataset.remove': {
      yield* assertDatasetRemovable(candidate, request.dataset_id);
      candidate = {
        ...candidate,
        datasets: candidate.datasets.filter(({ metadata }) => metadata.id !== request.dataset_id),
      };

      return {
        candidate,
        resource: { id: request.dataset_id, type: 'dataset' as const },
      } satisfies MutationBuildResult;
    }
  }
});

export { buildMutation, type TestAuthoringCommand, type TestMutationCommandOptions };
