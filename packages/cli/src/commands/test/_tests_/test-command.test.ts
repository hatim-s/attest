import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  COMMAND_REQUEST_SCHEMA_ID,
  TEST_RESOURCE_SCHEMA_ID,
  cliHelpSchema,
  cliResultSchema,
  type CommandRequest,
} from '@attest/contracts';
import { loadProject } from '@attest/local/project';
import { describe, expect, it } from 'vitest';

import {
  createFixtureProject,
  runCommand,
  runJson,
  snapshotTree,
} from '../../../_tests_/support/cli-test-support.js';
import { fixtureAgent } from '../../../_tests_/support/project-fixture.js';

const addTestRequest = (id: string): Extract<CommandRequest, { command: 'test.add' }> => ({
  schema: COMMAND_REQUEST_SCHEMA_ID,
  command: 'test.add',
  test: {
    schema: TEST_RESOURCE_SCHEMA_ID,
    id,
    name: id,
    agent_id: fixtureAgent.id,
    cases: [],
    datasets: [],
    metrics: [],
  },
});

/** A TTY terminal that answers every prompt with `answer(question)`. */
const promptingTerminal = (answer: (question: string) => string) => ({
  inputIsTTY: true,
  outputIsTTY: true,
  prompt: (question: string) => Promise.resolve(answer(question)),
});

describe('CLI test, case, dataset, and import authoring', { timeout: 20_000 }, () => {
  it('supports canonical test and direct-case happy paths', async () => {
    const root = await createFixtureProject();
    const commands = [
      ['test', 'add', 'smoke', '--agent', 'support'],
      ['test', 'case', 'add', 'smoke', '--id', 'ping', '--input', '{"question":"ping"}'],
    ];
    for (const argv of commands) expect((await runJson(root, argv)).exitCode).toBe(0);

    expect((await runJson(root, ['test', 'case', 'list', 'smoke'])).document).toMatchObject({
      ok: true,
      command: 'test.case.list',
      result: { test_id: 'smoke', items: [{ id: 'ping' }] },
    });
    expect((await runJson(root, ['test', 'case', 'show', 'smoke', 'ping'])).document).toMatchObject(
      { ok: true, result: { case: { id: 'ping', input: { question: 'ping' } } } },
    );

    const renames = [
      ['test', 'case', 'rename', 'smoke', 'ping', 'pong'],
      ['test', 'rename', 'smoke', 'smoke-renamed'],
      ['test', 'case', 'remove', 'smoke-renamed', 'pong', '--yes'],
      ['test', 'remove', 'smoke-renamed', '--yes'],
    ];
    for (const argv of renames) expect((await runJson(root, argv)).exitCode).toBe(0);
    expect((await loadProject({ project: root })).tests.map(({ id }) => id)).toEqual(['refund']);
  });

  it('reports non-TTY missing input and rejects overlapping request sources', async () => {
    const root = await createFixtureProject();
    expect((await runJson(root, ['test', 'add', 'missing-agent'])).document).toMatchObject({
      ok: false,
      error: { code: 'cli_missing_input', path: '--agent' },
    });

    const requestPath = join(root, 'request.json');
    await writeFile(requestPath, JSON.stringify(addTestRequest('from-json')));
    const overlap = await runJson(root, [
      'test',
      'add',
      'flag-id',
      '--agent',
      'support',
      '--from-json',
      requestPath,
    ]);
    expect(overlap).toMatchObject({
      exitCode: 2,
      document: {
        ok: false,
        error: { code: 'cli_usage', message: 'Command request sources overlap.' },
      },
    });
  });

  it('publishes machine help for the tabular import surface', async () => {
    const root = await createFixtureProject();
    const help = await runJson(root, ['help', 'test', 'case', 'import']);
    if (!help.document.ok) throw new Error('Expected structured import help.');
    const { command } = cliHelpSchema.parse(help.document.result);
    expect(command.path).toEqual(['test', 'case', 'import']);
    expect(command.request_schema).toBe(COMMAND_REQUEST_SCHEMA_ID);

    const option = (name: string) => command.options.find((entry) => entry.name === name);
    expect(option('map')).toMatchObject({ repeatable: true });
    expect(option('parse-json')).toMatchObject({ repeatable: true });
    expect(option('sync')).toMatchObject({ default: 'append' });
    expect(option('on-conflict')).toMatchObject({ default: 'error' });
    expect(option('records-pointer')).toBeDefined();
    expect(option('format')).toMatchObject({ choices: ['csv', 'json', 'jsonl'] });
    expect(command.examples.some((example) => example.includes('attest.command-request'))).toBe(
      true,
    );
    expect(command.constraints).toContain('upsert requires an explicit mapped id or --key source.');
  });

  it('serializes repeated human and JSON dry runs deterministically', async () => {
    const root = await createFixtureProject();
    const argv = ['test', 'add', 'deterministic', '--agent', 'support', '--dry-run'];
    const firstJson = await runJson(root, argv);
    const secondJson = await runJson(root, argv);
    expect(secondJson.output).toEqual(firstJson.output);

    const firstHuman = await runCommand(root, argv);
    const secondHuman = await runCommand(root, argv);
    expect(firstHuman.exitCode).toBe(0);
    expect(secondHuman.output).toEqual(firstHuman.output);
  });

  it('renders the same redacted import preview in human and JSON dry runs', async () => {
    const root = await createFixtureProject();
    await runJson(root, ['test', 'add', 'mapped', '--agent', 'support']);
    const source = join(root, 'mapped.csv');
    await writeFile(source, 'external_id,prompt,tags\none,hello,"[""smoke""]"\n');
    const argv = [
      'test',
      'case',
      'import',
      'mapped',
      source,
      '--map',
      'input.question=prompt',
      '--map',
      'tags=tags',
      '--parse-json',
      'tags',
      '--key',
      'external_id',
      '--sync',
      'upsert',
      '--dry-run',
    ];
    const before = await snapshotTree(root);

    const json = await runJson(root, argv);
    expect(json.document).toMatchObject({
      ok: true,
      result: {
        committed: false,
        import: {
          counts: { inserted: 1, read: 1, skipped: 0, updated: 0 },
          preview: [{ input: { question: '<redacted:string>' }, tags: ['<redacted:string>'] }],
        },
      },
    });
    const human = (await runCommand(root, argv)).output.join('\n');
    expect(human).toContain('Import: read 1, inserted 1, updated 0, skipped 0.');
    expect(human).toContain('<redacted:string>');
    expect(human).not.toContain('hello');
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('supports global common flags before the namespace with structured errors', async () => {
    const root = await createFixtureProject();
    const listed = await runCommand(root, [
      '--output',
      'json',
      '--non-interactive',
      'test',
      'list',
    ]);
    expect(listed.exitCode).toBe(0);
    expect(listed.errors).toEqual([]);
    expect(cliResultSchema.parse(JSON.parse(listed.output[0] ?? ''))).toMatchObject({
      ok: true,
      command: 'test.list',
    });

    const missing = await runCommand(root, [
      '--output=json',
      'test',
      'dataset',
      'attach',
      'refund',
      'absent',
    ]);
    expect(missing.exitCode).toBe(1);
    expect(cliResultSchema.parse(JSON.parse(missing.output[0] ?? ''))).toMatchObject({
      ok: false,
      command: 'test.dataset.attach',
      error: { hint: 'Run `attest list datasets` to inspect available ids.' },
    });
  });

  it('previews removals without confirmation and treats a guided no as a clean no-op', async () => {
    const root = await createFixtureProject();
    const before = await snapshotTree(root);
    expect(await runJson(root, ['test', 'remove', 'refund', '--dry-run'])).toMatchObject({
      exitCode: 0,
      document: { ok: true, result: { committed: false, dry_run: true } },
    });
    expect(await snapshotTree(root)).toEqual(before);

    const declined = await runCommand(root, ['test', 'remove', 'refund'], {
      interaction: promptingTerminal(() => 'n'),
    });
    expect(declined).toMatchObject({
      exitCode: 0,
      errors: [],
      output: ['No changes made; test refund was not removed.'],
    });
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('reports attached dataset blockers before prompting with exact detach commands', async () => {
    const root = await createFixtureProject();
    let promptCount = 0;
    const removed = await runCommand(root, ['test', 'dataset', 'remove', 'refunds'], {
      interaction: promptingTerminal(() => {
        promptCount += 1;
        return 'yes';
      }),
    });
    expect(removed.exitCode).toBe(1);
    expect(promptCount).toBe(0);
    expect(removed.errors.join('\n')).toContain('attest test dataset detach refund refunds');
  });

  it('supports stdin and --from-json parity for generalized import options', async () => {
    const root = await createFixtureProject();
    const request = JSON.stringify(addTestRequest('stdin-test'));
    expect(
      (await runJson(root, ['test', 'add', '--from-json', '-'], { stdin: request })).document,
    ).toMatchObject({ ok: true, command: 'test.add' });

    const cases = '{"input":"one"}\n{"input":"two"}\n';
    const stdinImport = await runJson(
      root,
      ['test', 'case', 'import', 'stdin-test', '-', '--format', 'jsonl'],
      { stdin: cases },
    );
    expect(stdinImport.document).toMatchObject({ ok: true, result: { imported_case_count: 2 } });

    const path = join(root, 'mapped-request.json');
    await writeFile(
      path,
      JSON.stringify({
        schema: COMMAND_REQUEST_SCHEMA_ID,
        command: 'test.case.import',
        test_id: 'stdin-test',
        source: '-',
        import: { format: 'csv', mapping: [{ destination: 'input', source: 'prompt' }] },
      }),
    );
    const imported = await runJson(root, ['test', 'case', 'import', '--from-json', path], {
      stdin: 'prompt\nmapped\n',
    });
    expect(imported).toMatchObject({
      exitCode: 0,
      document: {
        ok: true,
        result: {
          imported_case_count: 1,
          import: { format: 'csv', counts: { inserted: 1, read: 1 } },
        },
      },
    });
  });

  it('shows redacted aggregate import diagnostics in human mode', async () => {
    const root = await createFixtureProject();
    const source = join(root, 'invalid-private.csv');
    await writeFile(source, 'parameters,secret\nnot-an-array,private-prompt\n');
    const imported = await runCommand(root, [
      'test',
      'case',
      'import',
      'refund',
      source,
      '--map',
      'tags=parameters',
    ]);
    expect(imported.exitCode).toBe(1);
    const rendered = imported.errors.join('\n');
    expect(rendered).toContain('row 2, source parameters, destination /tags');
    expect(rendered).toContain('invalid_type');
    expect(rendered).not.toContain('private-prompt');
  });

  it('previews guided imports, defaults confirmation to no, and lets --yes bypass prompts', async () => {
    const root = await createFixtureProject();
    await runJson(root, ['test', 'add', 'guided', '--agent', 'support']);
    const source = join(root, 'guided.csv');
    await writeFile(source, 'prompt\nhello\n');
    const before = await snapshotTree(root);

    const declined = await runCommand(root, ['test', 'case', 'import', 'guided', source], {
      interaction: promptingTerminal(() => ''),
    });
    expect(declined.exitCode).toBe(0);
    expect(declined.output.join('\n')).toContain('Redacted normalized preview');
    expect(declined.output).toContain('No changes made; import was not applied.');
    expect(await snapshotTree(root)).toEqual(before);

    let promptCount = 0;
    const accepted = await runCommand(
      root,
      ['test', 'case', 'import', 'guided', source, '--map', 'input=prompt', '--yes'],
      {
        interaction: promptingTerminal(() => {
          promptCount += 1;
          return 'no';
        }),
      },
    );
    expect(accepted.exitCode).toBe(0);
    expect(promptCount).toBe(0);
    const guided = (await loadProject({ project: root })).tests.find(({ id }) => id === 'guided');
    expect(guided?.cases).toHaveLength(1);
  });

  it('prints the shared dataset preview with a confirmed shared update', async () => {
    const root = await createFixtureProject();
    const setup = [
      ['test', 'add', 'shared-owner', '--agent', 'support'],
      ['test', 'add', 'shared-reader', '--agent', 'support'],
      ['test', 'dataset', 'add', 'shared-owner', 'shared'],
      ['test', 'dataset', 'attach', 'shared-reader', 'shared'],
    ];
    for (const argv of setup) expect((await runJson(root, argv)).exitCode).toBe(0);
    const source = join(root, 'shared.jsonl');
    await writeFile(source, '{"id":"shared-case","input":"value"}\n');

    const confirmed = await runCommand(root, [
      'test',
      'dataset',
      'import',
      'shared-owner',
      source,
      '--as',
      'shared',
      '--sync',
      'upsert',
      '--yes',
    ]);
    expect(confirmed.exitCode).toBe(0);
    const human = confirmed.output.join('\n');
    expect(human).toContain('Shared dataset update preview:');
    expect(human).toContain('Dry run: would update dataset shared.');
    expect(human).toContain('Affected consumer tests: shared-owner, shared-reader.');
    expect(human).toContain('Confirmed shared dataset update:');
  });
});
