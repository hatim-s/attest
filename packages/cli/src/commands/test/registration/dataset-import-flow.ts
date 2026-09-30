import type { DatasetImportMapping } from '@attest/contracts';
import {
  prepareImportSource,
  runTestMutationCommand,
  validateCommandRequest,
  type TestAuthoringCommand,
} from '@attest/local/test';

import { AttestCliError } from '../../../errors/cli-error.js';
import { outputFormat, type MutationCliOptions } from '../../shared/cli-options.js';
import type { CommandContext } from '../../shared/command-context.js';
import { renderCommandResult } from '../../shared/command-result.js';
import { runTestMutation } from './run-test-mutation.js';

type ImportRequest = Extract<
  TestAuthoringCommand,
  { command: 'test.case.import' | 'test.dataset.import' }
>;

type DatasetImportRequest = Extract<TestAuthoringCommand, { command: 'test.dataset.import' }>;

/** Runs one import mutation against a source that was already read once. */
const runPreparedImport = (
  request: ImportRequest,
  options: MutationCliOptions,
  context: CommandContext,
  preparedImportSource: Uint8Array,
) =>
  runTestMutationCommand({
    preparedImportSource,
    project: options.project,
    readImportStdin: context.interaction.readImportStdin,
    readStdin: context.interaction.readStdin,
    request,
    workingDirectory: context.workingDirectory,
  });

/**
 * Applies a `--yes` dataset import bound to its own dry run: the commit must match the previewed
 * project hash. When the dataset is shared by two or more tests, the preview is printed with it.
 */
const runConfirmedDatasetImport = async (
  request: DatasetImportRequest,
  options: MutationCliOptions,
  context: CommandContext,
): Promise<void> => {
  const prepared = await prepareImportSource(
    request.source,
    context.workingDirectory,
    context.interaction.readImportStdin,
    request.import.format,
  );
  const preview = await runPreparedImport(
    validateCommandRequest('test.dataset.import', { ...request, dry_run: true }),
    options,
    context,
    prepared.source,
  );
  const { projectHashAfter, projectHashBefore } = preview;
  if (
    projectHashBefore === null ||
    projectHashBefore === undefined ||
    projectHashAfter === null ||
    projectHashAfter === undefined
  ) {
    throw new AttestCliError('internal_error', 'Dataset import preview returned no project hash.');
  }

  const confirmed = validateCommandRequest('test.dataset.import', {
    ...request,
    dry_run: false,
    if_project_hash: projectHashBefore,
    yes: true,
  });
  const committed = await runPreparedImport(confirmed, options, context, prepared.source);
  const affectedTests = preview.result.affected_tests ?? [];
  const result =
    affectedTests.length < 2
      ? committed
      : {
          ...committed,
          result: {
            ...committed.result,
            shared_dataset_preview: {
              affected_tests: affectedTests,
              import: preview.result.import ?? null,
              operations: preview.result.operations,
              project_hash_after: projectHashAfter,
              project_hash_before: projectHashBefore,
            },
          },
        };
  context.io.output(renderCommandResult('test.dataset.import', outputFormat(options), result));
};

/** Proposes mappings only from CSV headers that exactly match a well-known field name. */
const suggestedCsvMappings = (headers: readonly string[]): DatasetImportMapping[] => {
  const sourceFor = (...candidates: string[]): string | undefined =>
    candidates.find((candidate) => headers.includes(candidate));
  return [
    ['id', sourceFor('id', 'external_id')],
    ['input', sourceFor('input', 'prompt', 'question')],
    ['expected', sourceFor('expected', 'ideal', 'answer')],
    ['params', sourceFor('params', 'parameters')],
    ['tags', sourceFor('tags')],
  ].flatMap(([destination, source]) =>
    destination === undefined || source === undefined ? [] : [{ destination, source }],
  );
};

const confirmed = (answer: string): boolean => {
  const normalized = answer.trim().toLowerCase();
  return normalized === 'y' || normalized === 'yes';
};

/** Fills in CSV mappings from the headers after the user accepts them; null when declined. */
const withSuggestedMappings = async (
  request: ImportRequest,
  csvHeaders: readonly string[],
  context: CommandContext,
): Promise<ImportRequest | null> => {
  const suggestions = suggestedCsvMappings(csvHeaders);
  if (suggestions.length === 0) {
    throw new AttestCliError('cli_missing_input', 'No safe CSV field mappings were detected.', {
      path: '--map',
      hint: `Detected headers: ${csvHeaders.join(', ') || '<none>'}. Pass explicit --map destination=header options.`,
    });
  }
  const proposal = suggestions.map(({ destination, source }) => `${destination}=${source}`);
  const answer = (
    await context.interaction.prompt(
      `Detected CSV headers: ${csvHeaders.join(', ')}. Use mappings ${proposal.join(', ')}? [Y/n]: `,
    )
  )
    .trim()
    .toLowerCase();
  if (answer === 'n' || answer === 'no') {
    context.io.output('No changes made; pass explicit --map options to choose different mappings.');
    return null;
  }
  return validateCommandRequest(request.command, {
    ...request,
    import: { ...request.import, mapping: suggestions },
  });
};

/** Prints a dry-run preview of an import and applies it only after an explicit yes. */
const runGuidedImport = async (
  request: ImportRequest,
  options: MutationCliOptions,
  context: CommandContext,
): Promise<void> => {
  const prepared = await prepareImportSource(
    request.source,
    context.workingDirectory,
    context.interaction.readImportStdin,
    request.import.format,
  );
  const needsMappings = prepared.format === 'csv' && (request.import.mapping?.length ?? 0) === 0;
  const guided = needsMappings
    ? await withSuggestedMappings(request, prepared.csvHeaders, context)
    : request;
  if (guided === null) return;

  const preview = await runPreparedImport(
    validateCommandRequest(guided.command, { ...guided, dry_run: true }),
    options,
    context,
    prepared.source,
  );
  context.io.output(renderCommandResult(guided.command, 'human', preview));
  if (!confirmed(await context.interaction.prompt('Apply this import? [y/N]: '))) {
    context.io.output('No changes made; import was not applied.');
    return;
  }
  const applied = validateCommandRequest(guided.command, {
    ...guided,
    dry_run: false,
    if_project_hash: preview.projectHashBefore,
    yes: true,
  });
  await runTestMutation(applied, options, context, prepared.source);
};

export { runConfirmedDatasetImport, runGuidedImport };
