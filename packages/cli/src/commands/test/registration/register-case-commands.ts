import { parseJsonFlag, runTestCaseListCommand, runTestCaseShowCommand } from '@attest/local/test';
import type { Command } from 'commander';

import { setMutationHelp } from '../../../help/command-help.js';
import {
  addCommonOptions,
  addMutationOptions,
  collect,
  mutationRequestFields,
  outputFormat,
  promptContext,
  type CommonCliOptions,
  type MutationCliOptions,
} from '../../shared/cli-options.js';
import type { CommandContext } from '../../shared/command-context.js';
import { readOrBuildRequest } from '../../shared/command-request.js';
import { renderCommandResult } from '../../shared/command-result.js';
import { requiredInput } from '../../shared/required-input.js';
import { confirmRemoval } from './confirm-removal.js';
import { runGuidedImport } from './dataset-import-flow.js';
import {
  IMPORT_OPTION_HELP,
  addImportOptions,
  importRequestFields,
  type ImportCliOptions,
} from './import-options.js';
import { runTestMutation } from './run-test-mutation.js';

type CaseAddOptions = MutationCliOptions & {
  expected?: string;
  folder?: string;
  id?: string;
  input?: string;
  params?: string;
  tag?: string[];
};

const IMPORT_CONSTRAINTS = [
  'CSV mapping sources are exact header names; JSON and JSONL mapping sources are RFC 6901 pointers.',
  'sync defaults to append and on-conflict defaults to error.',
  'upsert requires an explicit mapped id or --key source.',
];

/** Registers direct case authoring, import, and inspection commands. */
const registerTestCaseCommands = (test: Command, context: CommandContext): void => {
  const testCase = test.command('case').description('Author direct test cases.');
  const caseAdd = addMutationOptions(testCase.command('add').description('Add one direct case.'))
    .argument('[test-id]', 'test id')
    .option('--id <case-id>', 'case id; generated from logical content when omitted')
    .option('--input <json>', 'case input JSON')
    .option('--expected <json>', 'optional expected JSON')
    .option('--params <json>', 'optional params object JSON')
    .option('--folder <folder>', 'logical case folder, such as billing/refunds')
    .option('--tag <tag>', 'case tag', collect)
    .action(async (testId: string | undefined, options: CaseAddOptions, leaf: Command) => {
      const prompt = promptContext(options, context.interaction);
      const request = await readOrBuildRequest({
        command: 'test.case.add',
        context,
        leaf,
        options,
        build: async () => {
          const inputText = await requiredInput(
            options.input,
            { path: '--input', question: 'Case input JSON: ' },
            prompt,
          );
          return {
            ...mutationRequestFields('test.case.add', options),
            test_id: await requiredInput(
              testId,
              { path: '<test-id>', question: 'Test id: ' },
              prompt,
            ),
            case: {
              ...(options.id === undefined ? {} : { id: options.id }),
              input: parseJsonFlag(inputText, '--input'),
              ...(options.expected === undefined
                ? {}
                : { expected: parseJsonFlag(options.expected, '--expected') }),
              ...(options.params === undefined
                ? {}
                : { params: parseJsonFlag(options.params, '--params') }),
              ...(options.tag === undefined ? {} : { tags: options.tag }),
              ...(options.folder === undefined ? {} : { folder: options.folder }),
            },
          };
        },
      });
      await runTestMutation(request, options, context);
    });
  setMutationHelp(caseAdd, {
    examples: ['attest test case add smoke --input \'{"question":"ping"}\''],
  });

  const caseImport = addImportOptions(
    testCase.command('import').description('Import mapped CSV, JSON, or JSONL direct cases.'),
  )
    .argument('[test-id]', 'test id')
    .argument('[source]', 'CSV/JSON/JSONL path or -')
    .action(
      async (
        testId: string | undefined,
        source: string | undefined,
        options: ImportCliOptions,
        leaf: Command,
      ) => {
        const prompt = promptContext(options, context.interaction);
        const request = await readOrBuildRequest({
          command: 'test.case.import',
          context,
          leaf,
          options,
          build: async () => ({
            ...mutationRequestFields('test.case.import', options),
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
            import: importRequestFields(options),
          }),
        });
        if (prompt.interactive && request.yes !== true && request.dry_run !== true) {
          await runGuidedImport(request, options, context);
          return;
        }
        await runTestMutation(request, options, context);
      },
    );
  setMutationHelp(caseImport, {
    examples: [
      'attest test case import smoke ./cases.jsonl',
      'attest test case import smoke ./cases.csv --map input.question=prompt --key external_id',
      'attest test case import smoke - --format jsonl --output json',
      'printf \'%s\\n\' \'{"schema":"attest.command-request","command":"test.case.import","test_id":"smoke","source":"./cases.csv","import":{"format":"csv","mapping":[{"destination":"input","source":"prompt"}],"sync":"append","on_conflict":"error"}}\' | attest test case import --from-json - --output json',
    ],
    constraints: IMPORT_CONSTRAINTS,
    options: IMPORT_OPTION_HELP,
  });

  addCommonOptions(testCase.command('list').description('List direct cases.'))
    .argument('[test-id]', 'test id')
    .action(async (testId: string | undefined, options: CommonCliOptions) => {
      const id = await requiredInput(
        testId,
        { path: '<test-id>', question: 'Test id: ' },
        promptContext(options, context.interaction),
      );
      const result = await runTestCaseListCommand({
        project: options.project,
        testId: id,
        workingDirectory: context.workingDirectory,
      });
      context.io.output(renderCommandResult('test.case.list', outputFormat(options), result));
    });

  addCommonOptions(testCase.command('show').description('Show one direct case.'))
    .argument('[test-id]', 'test id')
    .argument('[case-id]', 'direct case id')
    .action(
      async (testId: string | undefined, caseId: string | undefined, options: CommonCliOptions) => {
        const prompt = promptContext(options, context.interaction);
        const resolvedTestId = await requiredInput(
          testId,
          { path: '<test-id>', question: 'Test id: ' },
          prompt,
        );
        const resolvedCaseId = await requiredInput(
          caseId,
          { path: '<case-id>', question: 'Case id: ' },
          prompt,
        );
        const result = await runTestCaseShowCommand({
          caseId: resolvedCaseId,
          project: options.project,
          testId: resolvedTestId,
          workingDirectory: context.workingDirectory,
        });
        context.io.output(renderCommandResult('test.case.show', outputFormat(options), result));
      },
    );

  const caseRename = addMutationOptions(
    testCase.command('rename').description('Rename a direct case.'),
  )
    .argument('[test-id]', 'test id')
    .argument('[case-id]', 'direct case id')
    .argument('[new-id]', 'new direct case id')
    .action(
      async (
        testId: string | undefined,
        caseId: string | undefined,
        newId: string | undefined,
        options: MutationCliOptions,
        leaf: Command,
      ) => {
        const prompt = promptContext(options, context.interaction);
        const request = await readOrBuildRequest({
          command: 'test.case.rename',
          context,
          leaf,
          options,
          build: async () => ({
            ...mutationRequestFields('test.case.rename', options),
            test_id: await requiredInput(
              testId,
              { path: '<test-id>', question: 'Test id: ' },
              prompt,
            ),
            case_id: await requiredInput(
              caseId,
              { path: '<case-id>', question: 'Case id: ' },
              prompt,
            ),
            new_id: await requiredInput(
              newId,
              { path: '<new-id>', question: 'New case id: ' },
              prompt,
            ),
          }),
        });
        await runTestMutation(request, options, context);
      },
    );
  setMutationHelp(caseRename, {
    examples: ['attest test case rename smoke old-case new-case'],
  });

  const caseRemove = addMutationOptions(
    testCase.command('remove').description('Remove a direct case.'),
  )
    .argument('[test-id]', 'test id')
    .argument('[case-id]', 'direct case id')
    .action(
      async (
        testId: string | undefined,
        caseId: string | undefined,
        options: MutationCliOptions,
        leaf: Command,
      ) => {
        const prompt = promptContext(options, context.interaction);
        const request = await readOrBuildRequest({
          command: 'test.case.remove',
          context,
          leaf,
          options,
          build: async () => ({
            ...mutationRequestFields('test.case.remove', options),
            test_id: await requiredInput(
              testId,
              { path: '<test-id>', question: 'Test id: ' },
              prompt,
            ),
            case_id: await requiredInput(
              caseId,
              { path: '<case-id>', question: 'Case id: ' },
              prompt,
            ),
          }),
        });
        if (!(await confirmRemoval(request, `case ${request.case_id}`, options, context))) return;
        await runTestMutation(request, options, context);
      },
    );
  setMutationHelp(caseRemove, {
    examples: ['attest test case remove smoke old-case --yes'],
  });
};

export { registerTestCaseCommands };
