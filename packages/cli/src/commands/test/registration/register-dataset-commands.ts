import { CASE_SCHEMA_ID, DATASET_SCHEMA_ID } from '@attest/contracts';
import { runTestDatasetRemovePreflight } from '@attest/local/test';
import type { Command } from 'commander';

import { setCliCommandHelpMetadata, setMutationHelp } from '../../../help/command-help.js';
import {
  addMutationOptions,
  collect,
  mutationRequestFields,
  promptContext,
  type MutationCliOptions,
} from '../../shared/cli-options.js';
import type { CommandContext } from '../../shared/command-context.js';
import { readOrBuildRequest } from '../../shared/command-request.js';
import { requiredInput } from '../../shared/required-input.js';
import { confirmRemoval } from './confirm-removal.js';
import { runConfirmedDatasetImport, runGuidedImport } from './dataset-import-flow.js';
import {
  IMPORT_OPTION_HELP,
  addImportOptions,
  importRequestFields,
  type ImportCliOptions,
} from './import-options.js';
import { runTestMutation } from './run-test-mutation.js';

type DatasetAddOptions = MutationCliOptions & { name?: string };

type DatasetImportOptions = ImportCliOptions & { as?: string; name?: string };

type DatasetAttachOptions = MutationCliOptions & { tag?: string[] };

/** Registers attached dataset authoring, import, and lifecycle commands. */
const registerTestDatasetCommands = (test: Command, context: CommandContext): void => {
  const dataset = test.command('dataset').description('Add, import, and attach datasets.');
  const datasetAdd = addMutationOptions(
    dataset.command('add').description('Add an empty dataset and attach it atomically.'),
  )
    .argument('[test-id]', 'test id')
    .argument('[dataset-id]', 'new dataset id')
    .option('--name <name>', 'dataset display name')
    .action(
      async (
        testId: string | undefined,
        datasetId: string | undefined,
        options: DatasetAddOptions,
        leaf: Command,
      ) => {
        const prompt = promptContext(options, context.interaction);
        const request = await readOrBuildRequest({
          command: 'test.dataset.add',
          context,
          leaf,
          options,
          build: async () => {
            const id = await requiredInput(
              datasetId,
              { path: '<dataset-id>', question: 'Dataset id: ' },
              prompt,
            );
            return {
              ...mutationRequestFields('test.dataset.add', options),
              test_id: await requiredInput(
                testId,
                { path: '<test-id>', question: 'Test id: ' },
                prompt,
              ),
              dataset: {
                schema: DATASET_SCHEMA_ID,
                case_schema: CASE_SCHEMA_ID,
                id,
                name: options.name?.trim() || id,
                case_count: 0,
              },
            };
          },
        });
        await runTestMutation(request, options, context);
      },
    );
  setMutationHelp(datasetAdd, { examples: ['attest test dataset add smoke regression'] });

  const datasetImport = addImportOptions(
    dataset
      .command('import')
      .description('Import a mapped CSV, JSON, or JSONL dataset and attach it.'),
  )
    .argument('[test-id]', 'test id')
    .argument('[source]', 'CSV/JSON/JSONL path or -')
    .option('--as <dataset-id>', 'new dataset id')
    .option('--name <name>', 'dataset display name')
    .action(
      async (
        testId: string | undefined,
        source: string | undefined,
        options: DatasetImportOptions,
        leaf: Command,
      ) => {
        const prompt = promptContext(options, context.interaction);
        const request = await readOrBuildRequest({
          command: 'test.dataset.import',
          context,
          leaf,
          options,
          build: async () => ({
            ...mutationRequestFields('test.dataset.import', options),
            test_id: await requiredInput(
              testId,
              { path: '<test-id>', question: 'Test id: ' },
              prompt,
            ),
            source: await requiredInput(
              source,
              { path: '<source>', question: 'CSV/JSON/JSONL source: ' },
              prompt,
            ),
            as: await requiredInput(options.as, { path: '--as', question: 'Dataset id: ' }, prompt),
            ...(options.name === undefined ? {} : { name: options.name }),
            import: importRequestFields(options),
          }),
        });
        if (request.dry_run === true) {
          await runTestMutation(request, options, context);
          return;
        }
        if (request.yes === true) {
          await runConfirmedDatasetImport(request, options, context);
          return;
        }
        if (prompt.interactive) {
          await runGuidedImport(request, options, context);
          return;
        }
        await runTestMutation(request, options, context);
      },
    );
  setMutationHelp(datasetImport, {
    examples: [
      'attest test dataset import smoke ./cases.jsonl --as regression',
      'attest test dataset import smoke ./cases.csv --as regression --map input.question=prompt',
      'printf \'%s\\n\' \'{"schema":"attest.command-request","command":"test.dataset.import","test_id":"smoke","source":"./cases.jsonl","as":"regression","import":{"format":"jsonl","mapping":[{"destination":"input","source":"/prompt"}],"sync":"append","on_conflict":"error"}}\' | attest test dataset import --from-json - --output json',
    ],
    constraints: [
      'CSV mapping sources are exact header names; JSON and JSONL mapping sources are RFC 6901 pointers.',
      'sync defaults to append and on-conflict defaults to error.',
      'upsert requires an explicit mapped id or --key source.',
      'An existing dataset id requires sync=upsert; shared updates always show a semantic dry-run preview, and yes=true bypasses only its confirmation prompt.',
    ],
    options: IMPORT_OPTION_HELP,
  });

  const datasetAttach = addMutationOptions(
    dataset.command('attach').description('Attach a dataset.'),
  )
    .argument('[test-id]', 'test id')
    .argument('[dataset-id]', 'dataset id')
    .option('--tag <tag>', 'all-tags attachment filter', collect)
    .action(
      async (
        testId: string | undefined,
        datasetId: string | undefined,
        options: DatasetAttachOptions,
        leaf: Command,
      ) => {
        const prompt = promptContext(options, context.interaction);
        const request = await readOrBuildRequest({
          command: 'test.dataset.attach',
          context,
          leaf,
          options,
          build: async () => ({
            ...mutationRequestFields('test.dataset.attach', options),
            test_id: await requiredInput(
              testId,
              { path: '<test-id>', question: 'Test id: ' },
              prompt,
            ),
            dataset_id: await requiredInput(
              datasetId,
              { path: '<dataset-id>', question: 'Dataset id: ' },
              prompt,
            ),
            ...(options.tag === undefined ? {} : { tags: options.tag }),
          }),
        });
        await runTestMutation(request, options, context);
      },
    );
  setMutationHelp(datasetAttach, { examples: ['attest test dataset attach smoke regression'] });

  const datasetDetach = addMutationOptions(
    dataset.command('detach').description('Detach a dataset.'),
  )
    .argument('[test-id]', 'test id')
    .argument('[dataset-id]', 'dataset id')
    .action(
      async (
        testId: string | undefined,
        datasetId: string | undefined,
        options: MutationCliOptions,
        leaf: Command,
      ) => {
        const prompt = promptContext(options, context.interaction);
        const request = await readOrBuildRequest({
          command: 'test.dataset.detach',
          context,
          leaf,
          options,
          build: async () => ({
            ...mutationRequestFields('test.dataset.detach', options),
            test_id: await requiredInput(
              testId,
              { path: '<test-id>', question: 'Test id: ' },
              prompt,
            ),
            dataset_id: await requiredInput(
              datasetId,
              { path: '<dataset-id>', question: 'Dataset id: ' },
              prompt,
            ),
          }),
        });
        await runTestMutation(request, options, context);
      },
    );
  setMutationHelp(datasetDetach, { examples: ['attest test dataset detach smoke regression'] });

  const datasetRename = addMutationOptions(
    dataset.command('rename').description('Rename a dataset and every attachment atomically.'),
  )
    .argument('[dataset-id]', 'current dataset id')
    .argument('[new-id]', 'new dataset id')
    .action(
      async (
        datasetId: string | undefined,
        newId: string | undefined,
        options: MutationCliOptions,
        leaf: Command,
      ) => {
        const prompt = promptContext(options, context.interaction);
        const request = await readOrBuildRequest({
          command: 'test.dataset.rename',
          context,
          leaf,
          options,
          build: async () => ({
            ...mutationRequestFields('test.dataset.rename', options),
            dataset_id: await requiredInput(
              datasetId,
              { path: '<dataset-id>', question: 'Current dataset id: ' },
              prompt,
            ),
            new_id: await requiredInput(
              newId,
              { path: '<new-id>', question: 'New dataset id: ' },
              prompt,
            ),
          }),
        });
        await runTestMutation(request, options, context);
      },
    );
  setMutationHelp(datasetRename, {
    examples: ['attest test dataset rename regression regression-renamed'],
  });

  const datasetRemove = addMutationOptions(
    dataset.command('remove').description('Remove an unattached dataset.'),
  )
    .argument('[dataset-id]', 'dataset id')
    .action(async (datasetId: string | undefined, options: MutationCliOptions, leaf: Command) => {
      const request = await readOrBuildRequest({
        command: 'test.dataset.remove',
        context,
        leaf,
        options,
        build: async () => ({
          ...mutationRequestFields('test.dataset.remove', options),
          dataset_id: await requiredInput(
            datasetId,
            { path: '<dataset-id>', question: 'Dataset id: ' },
            promptContext(options, context.interaction),
          ),
        }),
      });
      if (request.dry_run !== true) {
        await runTestDatasetRemovePreflight({
          datasetId: request.dataset_id,
          project: options.project,
          workingDirectory: context.workingDirectory,
        });
      }
      if (!(await confirmRemoval(request, `dataset ${request.dataset_id}`, options, context))) {
        return;
      }
      await runTestMutation(request, options, context);
    });
  setMutationHelp(datasetRemove, { examples: ['attest test dataset remove regression --yes'] });

  setCliCommandHelpMetadata(test, {
    examples: [
      'attest test add smoke --agent support',
      'attest test case add smoke --input \'{"question":"ping"}\'',
      'attest test dataset import smoke ./cases.jsonl --as regression',
    ],
  });
};

export { registerTestDatasetCommands };
