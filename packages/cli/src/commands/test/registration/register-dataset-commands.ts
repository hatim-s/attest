import { CASE_SCHEMA_ID, DATASET_SCHEMA_ID } from '@attest/contracts';
import type { Command } from 'commander';

import { setCliCommandHelpMetadata } from '../../../help/command-help.js';
import {
  addImportOptions,
  addMutationOptions,
  collect,
  commonRequestFields,
  confirmRemoval,
  importRequestFields,
  isInteractive,
  markMutationHelp,
  requestFromSource,
  requiredInput,
  runConfirmedDatasetImport,
  runGuidedImport,
  runMutation,
  type DatasetOptions,
  type MutationOptions,
  type RegisterTestCommandsOptions,
} from './support.js';
import { runTestDatasetRemovePreflight } from '../test-command.js';

/** Registers attached dataset authoring, import, and lifecycle commands. */
const registerTestDatasetCommands = (test: Command, context: RegisterTestCommandsOptions): void => {
  const dataset = test.command('dataset').description('Add, import, and attach datasets.');
  const datasetAdd = addMutationOptions(
    dataset.command('add').description('Add an empty dataset and attach it atomically.'),
  )
    .argument('[test-id]', 'test id')
    .argument('[dataset-id]', 'new dataset id')
    .option('--name <name>', 'dataset display name');
  datasetAdd.action(
    async (testId: string | undefined, datasetId: string | undefined, options: DatasetOptions) => {
      const interactive = isInteractive(options, context.interaction, options.fromJson);
      const request = await requestFromSource(
        'test.dataset.add',
        options,
        { 'test-id': testId, 'dataset-id': datasetId, name: options.name },
        context,
        async () => {
          const id = await requiredInput(
            datasetId,
            '<dataset-id>',
            'Dataset id: ',
            interactive,
            context.interaction,
          );
          return {
            ...commonRequestFields('test.dataset.add', options),
            test_id: await requiredInput(
              testId,
              '<test-id>',
              'Test id: ',
              interactive,
              context.interaction,
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
      );
      await runMutation('test.dataset.add', request, options, context);
    },
  );
  markMutationHelp(datasetAdd, ['attest test dataset add smoke regression']);

  const datasetImport = addImportOptions(
    dataset
      .command('import')
      .description('Import a mapped CSV, JSON, or JSONL dataset and attach it.'),
  )
    .argument('[test-id]', 'test id')
    .argument('[source]', 'CSV/JSON/JSONL path or -')
    .option('--as <dataset-id>', 'new dataset id')
    .option('--name <name>', 'dataset display name');
  datasetImport.action(
    async (testId: string | undefined, source: string | undefined, options: DatasetOptions) => {
      const interactive = isInteractive(options, context.interaction, options.fromJson);
      const request = await requestFromSource(
        'test.dataset.import',
        options,
        {
          'test-id': testId,
          source,
          as: options.as,
          name: options.name,
          format: options.format,
          map: options.map,
          'parse-json': options.parseJson,
          'records-pointer': options.recordsPointer,
          key: options.key,
          dedupe: options.dedupe,
          'on-conflict': options.onConflict,
          sync: options.sync,
        },
        context,
        async () => ({
          ...commonRequestFields('test.dataset.import', options),
          test_id: await requiredInput(
            testId,
            '<test-id>',
            'Test id: ',
            interactive,
            context.interaction,
          ),
          source: await requiredInput(
            source,
            '<source>',
            'CSV/JSON/JSONL source: ',
            interactive,
            context.interaction,
          ),
          as: await requiredInput(
            options.as,
            '--as',
            'Dataset id: ',
            interactive,
            context.interaction,
          ),
          ...(options.name === undefined ? {} : { name: options.name }),
          import: importRequestFields(options),
        }),
      );
      if (request.yes === true && request.dry_run !== true) {
        await runConfirmedDatasetImport(request, options, context);
      } else if (interactive && request.dry_run !== true) {
        await runGuidedImport('test.dataset.import', request, options, context);
      } else {
        await runMutation('test.dataset.import', request, options, context);
      }
    },
  );
  markMutationHelp(
    datasetImport,
    [
      'attest test dataset import smoke ./cases.jsonl --as regression',
      'attest test dataset import smoke ./cases.csv --as regression --map input.question=prompt',
      'printf \'%s\\n\' \'{"schema":"attest.command-request","command":"test.dataset.import","test_id":"smoke","source":"./cases.jsonl","as":"regression","import":{"format":"jsonl","mapping":[{"destination":"input","source":"/prompt"}],"sync":"append","on_conflict":"error"}}\' | attest test dataset import --from-json - --output json',
    ],
    {
      constraints: [
        'CSV mapping sources are exact header names; JSON and JSONL mapping sources are RFC 6901 pointers.',
        'sync defaults to append and on-conflict defaults to error.',
        'upsert requires an explicit mapped id or --key source.',
        'An existing dataset id requires sync=upsert; shared updates always show a semantic dry-run preview, and yes=true bypasses only its confirmation prompt.',
      ],
      importOptions: true,
    },
  );

  for (const verb of ['attach', 'detach'] as const) {
    const command = addMutationOptions(
      dataset.command(verb).description(`${verb === 'attach' ? 'Attach' : 'Detach'} a dataset.`),
    )
      .argument('[test-id]', 'test id')
      .argument('[dataset-id]', 'dataset id');
    if (verb === 'attach') command.option('--tag <tag>', 'all-tags attachment filter', collect);
    command.action(
      async (
        testId: string | undefined,
        datasetId: string | undefined,
        options: DatasetOptions,
      ) => {
        const commandName = `test.dataset.${verb}` as const;
        const interactive = isInteractive(options, context.interaction, options.fromJson);
        const request = await requestFromSource(
          commandName,
          options,
          { 'test-id': testId, 'dataset-id': datasetId, tag: options.tag },
          context,
          async () => ({
            ...commonRequestFields(commandName, options),
            test_id: await requiredInput(
              testId,
              '<test-id>',
              'Test id: ',
              interactive,
              context.interaction,
            ),
            dataset_id: await requiredInput(
              datasetId,
              '<dataset-id>',
              'Dataset id: ',
              interactive,
              context.interaction,
            ),
            ...(verb === 'attach' && options.tag !== undefined ? { tags: options.tag } : {}),
          }),
        );
        await runMutation(commandName, request, options, context);
      },
    );
    markMutationHelp(command, [`attest test dataset ${verb} smoke regression`]);
  }

  const datasetRename = addMutationOptions(
    dataset.command('rename').description('Rename a dataset and every attachment atomically.'),
  )
    .argument('[dataset-id]', 'current dataset id')
    .argument('[new-id]', 'new dataset id');
  datasetRename.action(
    async (datasetId: string | undefined, newId: string | undefined, options: MutationOptions) => {
      const interactive = isInteractive(options, context.interaction, options.fromJson);
      const request = await requestFromSource(
        'test.dataset.rename',
        options,
        { 'dataset-id': datasetId, 'new-id': newId },
        context,
        async () => ({
          ...commonRequestFields('test.dataset.rename', options),
          dataset_id: await requiredInput(
            datasetId,
            '<dataset-id>',
            'Current dataset id: ',
            interactive,
            context.interaction,
          ),
          new_id: await requiredInput(
            newId,
            '<new-id>',
            'New dataset id: ',
            interactive,
            context.interaction,
          ),
        }),
      );
      await runMutation('test.dataset.rename', request, options, context);
    },
  );
  markMutationHelp(datasetRename, ['attest test dataset rename regression regression-renamed']);

  const datasetRemove = addMutationOptions(
    dataset.command('remove').description('Remove an unattached dataset.'),
  ).argument('[dataset-id]', 'dataset id');
  datasetRemove.action(async (datasetId: string | undefined, options: MutationOptions) => {
    const request = await requestFromSource(
      'test.dataset.remove',
      options,
      { 'dataset-id': datasetId },
      context,
      async () => ({
        ...commonRequestFields('test.dataset.remove', options),
        dataset_id: await requiredInput(
          datasetId,
          '<dataset-id>',
          'Dataset id: ',
          isInteractive(options, context.interaction, options.fromJson),
          context.interaction,
        ),
      }),
    );
    if (request.dry_run !== true) {
      await runTestDatasetRemovePreflight({
        datasetId: request.dataset_id,
        project: options.project,
        workingDirectory: context.workingDirectory,
      });
    }
    if (!(await confirmRemoval(request, `dataset ${request.dataset_id}`, options, context))) return;
    await runMutation('test.dataset.remove', request, options, context);
  });
  markMutationHelp(datasetRemove, ['attest test dataset remove regression --yes']);

  setCliCommandHelpMetadata(test, {
    examples: [
      'attest test add smoke --agent support',
      'attest test case add smoke --input \'{"question":"ping"}\'',
      'attest test dataset import smoke ./cases.jsonl --as regression',
    ],
  });
};

export { registerTestDatasetCommands };
