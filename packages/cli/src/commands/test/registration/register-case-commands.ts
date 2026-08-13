import type { Command } from 'commander';

import {
  addCommonOptions,
  addImportOptions,
  addMutationOptions,
  collect,
  commonRequestFields,
  confirmRemoval,
  importRequestFields,
  isInteractive,
  markMutationHelp,
  outputFormat,
  renderCommandResult,
  requestFromSource,
  requiredInput,
  runGuidedImport,
  runMutation,
  type CaseOptions,
  type CommonOptions,
  type MutationOptions,
  type RegisterTestCommandsOptions,
} from './support.js';
import { parseJsonFlag } from '../test-command-input.js';
import { runTestCaseListCommand, runTestCaseShowCommand } from '../test-command.js';

/** Registers direct case authoring, import, and inspection commands. */
const registerTestCaseCommands = (test: Command, context: RegisterTestCommandsOptions): void => {
  const testCase = test.command('case').description('Author direct test cases.');
  const caseAdd = addMutationOptions(testCase.command('add').description('Add one direct case.'))
    .argument('[test-id]', 'test id')
    .option('--id <case-id>', 'case id; generated from logical content when omitted')
    .option('--input <json>', 'case input JSON')
    .option('--expected <json>', 'optional expected JSON')
    .option('--params <json>', 'optional params object JSON')
    .option('--tag <tag>', 'case tag', collect);
  caseAdd.action(async (testId: string | undefined, options: CaseOptions) => {
    const interactive = isInteractive(options, context.interaction, options.fromJson);
    const request = await requestFromSource(
      'test.case.add',
      options,
      {
        'test-id': testId,
        id: options.id,
        input: options.input,
        expected: options.expected,
        params: options.params,
        tag: options.tag,
      },
      context,
      async () => {
        const inputText = await requiredInput(
          options.input,
          '--input',
          'Case input JSON: ',
          interactive,
          context.interaction,
        );
        return {
          ...commonRequestFields('test.case.add', options),
          test_id: await requiredInput(
            testId,
            '<test-id>',
            'Test id: ',
            interactive,
            context.interaction,
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
          },
        };
      },
    );
    await runMutation('test.case.add', request, options, context);
  });
  markMutationHelp(caseAdd, ['attest test case add smoke --input \'{"question":"ping"}\'']);

  const caseImport = addImportOptions(
    testCase.command('import').description('Import mapped CSV, JSON, or JSONL direct cases.'),
  )
    .argument('[test-id]', 'test id')
    .argument('[source]', 'CSV/JSON/JSONL path or -');
  caseImport.action(
    async (testId: string | undefined, source: string | undefined, options: CaseOptions) => {
      const interactive = isInteractive(options, context.interaction, options.fromJson);
      const request = await requestFromSource(
        'test.case.import',
        options,
        {
          'test-id': testId,
          source,
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
          ...commonRequestFields('test.case.import', options),
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
          import: importRequestFields(options),
        }),
      );
      if (interactive && request.yes !== true && request.dry_run !== true) {
        await runGuidedImport('test.case.import', request, options, context);
      } else {
        await runMutation('test.case.import', request, options, context);
      }
    },
  );
  markMutationHelp(
    caseImport,
    [
      'attest test case import smoke ./cases.jsonl',
      'attest test case import smoke ./cases.csv --map input.question=prompt --key external_id',
      'attest test case import smoke - --format jsonl --output json',
      'printf \'%s\\n\' \'{"schema":"attest.command-request","command":"test.case.import","test_id":"smoke","source":"./cases.csv","import":{"format":"csv","mapping":[{"destination":"input","source":"prompt"}],"sync":"append","on_conflict":"error"}}\' | attest test case import --from-json - --output json',
    ],
    {
      constraints: [
        'CSV mapping sources are exact header names; JSON and JSONL mapping sources are RFC 6901 pointers.',
        'sync defaults to append and on-conflict defaults to error.',
        'upsert requires an explicit mapped id or --key source.',
      ],
      importOptions: true,
    },
  );

  addCommonOptions(testCase.command('list').description('List direct cases.'))
    .argument('[test-id]', 'test id')
    .action(async (testId: string | undefined, options: CommonOptions) => {
      const id = await requiredInput(
        testId,
        '<test-id>',
        'Test id: ',
        isInteractive(options, context.interaction),
        context.interaction,
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
      async (testId: string | undefined, caseId: string | undefined, options: CommonOptions) => {
        const interactive = isInteractive(options, context.interaction);
        const resolvedTestId = await requiredInput(
          testId,
          '<test-id>',
          'Test id: ',
          interactive,
          context.interaction,
        );
        const resolvedCaseId = await requiredInput(
          caseId,
          '<case-id>',
          'Case id: ',
          interactive,
          context.interaction,
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

  for (const verb of ['rename', 'remove'] as const) {
    const command = addMutationOptions(
      testCase
        .command(verb)
        .description(`${verb === 'rename' ? 'Rename' : 'Remove'} a direct case.`),
    )
      .argument('[test-id]', 'test id')
      .argument('[case-id]', 'direct case id');
    if (verb === 'rename') command.argument('[new-id]', 'new direct case id');
    command.action(
      async (
        testId: string | undefined,
        caseId: string | undefined,
        newIdOrOptions: string | MutationOptions | undefined,
        maybeOptions?: MutationOptions,
      ) => {
        // Commander passes the options object immediately after the declared positional values.
        const options = (verb === 'rename' ? maybeOptions : newIdOrOptions) as MutationOptions;
        const newId = typeof newIdOrOptions === 'string' ? newIdOrOptions : undefined;
        const commandName = `test.case.${verb}` as const;
        const interactive = isInteractive(options, context.interaction, options.fromJson);
        const request = await requestFromSource(
          commandName,
          options,
          { 'test-id': testId, 'case-id': caseId, 'new-id': newId },
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
            case_id: await requiredInput(
              caseId,
              '<case-id>',
              'Case id: ',
              interactive,
              context.interaction,
            ),
            ...(verb === 'rename'
              ? {
                  new_id: await requiredInput(
                    newId,
                    '<new-id>',
                    'New case id: ',
                    interactive,
                    context.interaction,
                  ),
                }
              : {}),
          }),
        );
        if (verb === 'remove') {
          if (!(await confirmRemoval(request, `case ${request.case_id}`, options, context))) return;
        }
        await runMutation(commandName, request, options, context);
      },
    );
    markMutationHelp(command, [
      verb === 'rename'
        ? 'attest test case rename smoke old-case new-case'
        : 'attest test case remove smoke old-case --yes',
    ]);
  }
};

export { registerTestCaseCommands };
