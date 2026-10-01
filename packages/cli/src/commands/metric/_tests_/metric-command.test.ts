import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  COMMAND_REQUEST_SCHEMA_ID,
  METRIC_PRESETS,
  METRIC_RESOURCE_SCHEMA_ID,
  METRIC_TEST_FIXTURE_SCHEMA_ID,
  cliHelpSchema,
  type MetricResource,
  type MetricTestFixture,
} from '@attest/contracts';
import { loadProject } from '@attest/local/project';
import { describe, expect, it } from 'vitest';

import {
  createEmptyProject,
  runCommand,
  runJson,
  snapshotTree,
} from '../../../_tests_/support/cli-test-support.js';
import type { CliInteraction } from '../../shared/cli-interaction.js';

const assertionMetric = (id: string): MetricResource => ({
  schema: METRIC_RESOURCE_SCHEMA_ID,
  id,
  name: id,
  definition: {
    kind: 'assertion',
    assertions: [{ equals: { path: '$.output.answer', value: 'Paris' } }],
  },
});

const metricFixture = (answer: string): MetricTestFixture => ({
  schema: METRIC_TEST_FIXTURE_SCHEMA_ID,
  case: { id: 'local-case', input: { question: 'Capital?' }, expected: 'Paris' },
  expected_pass: true,
  output: { answer },
  trace: { schema: 'attest.trace', trace_id: 'trace-local', spans: [] },
});

/** A TTY that answers each prompt containing a key with its value, and `yes` otherwise. */
const guidedTerminal = (
  answers: Readonly<Record<string, string>>,
  questions: string[] = [],
): Partial<CliInteraction> => ({
  inputIsTTY: true,
  outputIsTTY: true,
  prompt: (question) => {
    questions.push(question);
    const key = Object.keys(answers).find((candidate) => question.includes(candidate));
    return Promise.resolve(key === undefined ? 'yes' : (answers[key] ?? ''));
  },
});

/** Options every mutation leaf registers besides its own fields. */
const COMMON_OPTIONS = ['project', 'output', 'non-interactive', 'from-json'];
const MUTATION_OPTIONS = ['dry-run', 'if-project-hash', 'yes'];

describe('metric commands', { timeout: 30_000 }, () => {
  it('authors a preset metric and a complete assertion JSON metric', async () => {
    const root = await createEmptyProject();
    const preset = await runJson(root, [
      'metric',
      'add',
      'equals',
      '--preset',
      'output-equals',
      '--value',
      '"Paris"',
    ]);
    expect(preset.exitCode).toBe(0);
    const composition = await runJson(root, [
      'metric',
      'add',
      'composition',
      '--assert-json',
      '{"exists":{"path":"$.output"}}',
      '--assert-json',
      '{"not":{"equals":{"path":"$.output","value":null}}}',
    ]);
    expect(composition.exitCode).toBe(0);

    const loaded = await loadProject({ project: root });
    expect(loaded.metrics.find(({ id }) => id === 'equals')?.definition).toEqual({
      kind: 'assertion',
      assertions: [{ equals: { path: '$.output', value: 'Paris' } }],
    });
    expect(loaded.metrics.find(({ id }) => id === 'composition')?.definition).toEqual({
      kind: 'assertion',
      assertions: [
        { exists: { path: '$.output' } },
        { not: { equals: { path: '$.output', value: null } } },
      ],
    });
  });

  it('keeps guided, flag, stdin, import, and from-json routes on canonical resources', async () => {
    const root = await createEmptyProject();
    const traced = await runJson(root, [
      'agent',
      'add',
      'traced',
      '--argv-json',
      JSON.stringify([process.execPath]),
      '--trace',
    ]);
    expect(traced.exitCode).toBe(0);

    const questions: string[] = [];
    const guided = await runCommand(root, ['metric', 'add'], {
      interaction: guidedTerminal(
        {
          'Metric id: ': 'guided',
          'Metric catalog': 'assertion',
          'Assertion evidence': 'expected',
          'Assertion operator': 'contains',
          'JSON value: ': '"needle"',
        },
        questions,
      ),
    });
    expect(guided.errors).toEqual([]);
    expect(guided.exitCode).toBe(0);
    expect(questions[1]).toMatch(/^Metric catalog \(attest\.metric-preset\):/u);
    expect(questions[1]).not.toContain('attest.metric-preset/v1');
    expect(questions[1]).toContain('trace-capable fixture');
    expect(questions).toContain('Assertion evidence [output] (input|output|expected|trace): ');
    expect(questions).toContain(
      'Assertion operator for $.expected [equals] (equals|contains|json-schema|regex|exists|lt|lte|gt|gte): ',
    );
    expect(questions).toContain(
      'Assertion preview: evidence=$.expected; operator=contains.\nJSON value: ',
    );
    expect(questions.at(-1)).toContain('Apply these changes? [y/N]');

    const defaults = await runCommand(root, ['metric', 'add', 'guided-default'], {
      interaction: guidedTerminal({
        'Metric catalog': '',
        'Assertion evidence': '',
        'Assertion operator': '',
        'JSON value: ': 'null',
      }),
    });
    expect(defaults.exitCode).toBe(0);

    const traceQuestions: string[] = [];
    const trace = await runCommand(root, ['metric', 'add', 'guided-trace'], {
      interaction: guidedTerminal(
        {
          'Metric catalog': 'assertion',
          'Assertion evidence': 'trace',
          'Agent trace capabilities': 'traced',
          'Trace operator': 'tool-called',
          'Tool name: ': 'search',
        },
        traceQuestions,
      ),
    });
    expect(trace.exitCode).toBe(0);
    expect(traceQuestions.join('\n')).toContain('traced: advertises trace support');
    expect(traceQuestions.join('\n')).toContain(
      'Agent traced advertises trace support. Creation remains available before trace evidence exists.',
    );
    expect(traceQuestions).toContain(
      'Assertion preview: evidence=trace; operator=tool-called.\nTool name: ',
    );

    const requested = await runJson(root, ['metric', 'add', '--from-json', '-'], {
      stdin: JSON.stringify({
        schema: COMMAND_REQUEST_SCHEMA_ID,
        command: 'metric.add',
        metric: assertionMetric('requested'),
      }),
    });
    expect(requested.exitCode).toBe(0);
    const imported = await runJson(
      root,
      ['metric', 'import', '-', '--type', 'json', '--as', 'imported'],
      { stdin: JSON.stringify(assertionMetric('source')) },
    );
    expect(imported.exitCode).toBe(0);
    const judge = await runJson(
      root,
      [
        'metric',
        'add',
        'judge',
        '--preset',
        'judge-rubric',
        '--model',
        'openai/gpt-5',
        '--rubric-file',
        '-',
      ],
      { stdin: 'Judge correctness against expected output.' },
    );
    expect(judge.exitCode).toBe(0);

    const definitions = new Map(
      (await loadProject({ project: root })).metrics.map(({ id, definition }) => [id, definition]),
    );
    expect([...definitions.keys()].sort()).toEqual([
      'guided',
      'guided-default',
      'guided-trace',
      'imported',
      'judge',
      'requested',
    ]);
    expect(definitions.get('guided')).toEqual({
      kind: 'assertion',
      assertions: [{ contains: { path: '$.expected', value: 'needle' } }],
    });
    expect(definitions.get('guided-default')).toEqual({
      kind: 'assertion',
      assertions: [{ equals: { path: '$.output', value: null } }],
    });
    expect(definitions.get('guided-trace')).toMatchObject({
      kind: 'assertion',
      assertions: [{ tool_calls: { name: 'search' } }],
    });
    expect(definitions.get('judge')).toMatchObject({
      kind: 'judge',
      rubric: 'Judge correctness against expected output.',
    });
  });

  it('renders a fixture verdict and exits 1 on an expected_pass mismatch', async () => {
    const root = await createEmptyProject();
    const fixturePath = join(root, 'fixture.json');
    await writeFile(fixturePath, JSON.stringify(metricFixture('Paris')));
    const mismatchPath = join(root, 'mismatch.json');
    await writeFile(mismatchPath, JSON.stringify(metricFixture('London')));
    await runJson(root, ['metric', 'add', '--from-json', '-'], {
      stdin: JSON.stringify({
        schema: COMMAND_REQUEST_SCHEMA_ID,
        command: 'metric.add',
        metric: assertionMetric('exact'),
      }),
    });

    const human = await runCommand(root, ['metric', 'test', 'exact', '--fixture', fixturePath]);
    expect(human).toMatchObject({
      errors: [],
      exitCode: 0,
      output: ['Metric exact matched expected_pass=true.'],
    });
    const mismatch = await runJson(root, ['metric', 'test', 'exact', '--fixture', mismatchPath]);
    expect(mismatch.exitCode).toBe(1);
    expect(mismatch.document).toMatchObject({
      ok: false,
      error: { code: 'metric_fixture_mismatch' },
    });
  });

  it('keeps a dry run guarded by the current project hash write-free', async () => {
    const root = await createEmptyProject();
    const before = await snapshotTree(root);
    const { projectHash } = await loadProject({ project: root });
    const preview = await runJson(root, [
      'metric',
      'add',
      'preview',
      '--preset',
      'output-equals',
      '--value',
      'null',
      '--dry-run',
      '--if-project-hash',
      projectHash,
    ]);
    expect(preview.document).toMatchObject({
      ok: true,
      result: { committed: false, dry_run: true },
    });
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('returns strict missing-input, overlapping-source, and incompatible-flag errors without writing', async () => {
    const root = await createEmptyProject();
    const missing = await runJson(root, ['metric', 'add', 'missing']);
    expect(missing.document).toMatchObject({
      ok: false,
      error: { code: 'cli_missing_input', path: '--preset' },
    });

    const requestPath = join(root, 'request.json');
    await writeFile(
      requestPath,
      JSON.stringify({
        schema: COMMAND_REQUEST_SCHEMA_ID,
        command: 'metric.add',
        metric: assertionMetric('requested'),
      }),
    );
    const before = await snapshotTree(root);
    const overlap = await runJson(root, [
      'metric',
      'add',
      'flag-id',
      '--preset',
      'output-equals',
      '--value',
      'null',
      '--from-json',
      requestPath,
    ]);
    expect(overlap.exitCode).toBe(2);
    expect(overlap.document).toMatchObject({
      ok: false,
      error: { code: 'cli_usage', message: 'Command request sources overlap.' },
    });

    const incompatible = await runJson(root, [
      'metric',
      'add',
      'incompatible',
      '--preset',
      'no-tool-errors',
      '--url',
      'https://metric.example/evaluate',
    ]);
    expect(incompatible.exitCode).toBe(2);
    expect(incompatible.document).toMatchObject({
      ok: false,
      error: { code: 'cli_usage', details: { incompatible_flags: ['--url'] } },
    });
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('omits a rejected credential literal from the command output', async () => {
    const root = await createEmptyProject();
    const secret = 'literal-camel-access-secret';
    const rejected = await runJson(root, [
      'metric',
      'add',
      'flag-secret',
      '--preset',
      'http',
      '--url',
      'https://metric.example/evaluate',
      '--body-json',
      JSON.stringify({ accessToken: secret }),
    ]);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.document).toMatchObject({ ok: false, error: { code: 'project_invalid' } });
    expect(rejected.output.join('\n')).not.toContain(secret);
  });

  it('derives repeatable flags and from-json conflicts in metric add help', async () => {
    const root = await createEmptyProject();
    const help = await runJson(root, ['help', 'metric', 'add']);
    if (!help.document.ok) throw new Error('Expected metric help success.');
    const { command } = cliHelpSchema.parse(help.document.result);
    expect(command.path).toEqual(['metric', 'add']);
    expect(command.request_schema).toBe(COMMAND_REQUEST_SCHEMA_ID);
    expect(command.presets).toEqual(METRIC_PRESETS);
    expect(
      command.options
        .filter(({ repeatable }) => repeatable)
        .map(({ name }) => name)
        .sort(),
    ).toEqual([
      'arg-contains',
      'arg-equals',
      'arg-exists',
      'assert-json',
      'attribute',
      'env',
      'header-env',
      'order',
      'query-env',
    ]);

    const fieldOptions = command.options
      .map(({ name }) => name)
      .filter((name) => !COMMON_OPTIONS.includes(name) && !MUTATION_OPTIONS.includes(name));
    const fromJson = command.options.find(({ name }) => name === 'from-json');
    expect([...(fromJson?.conflicts ?? [])].sort()).toEqual(
      [...MUTATION_OPTIONS, 'metric-id', ...fieldOptions].sort(),
    );
    for (const option of command.options.filter(({ name }) => fieldOptions.includes(name))) {
      expect(option.conflicts).toContain('from-json');
    }

    const metricHelp = await runJson(root, ['help', 'metric']);
    if (!metricHelp.document.ok) throw new Error('Expected metric help success.');
    expect(
      cliHelpSchema.parse(metricHelp.document.result).command.subcommands.map(({ name }) => name),
    ).toEqual(['add', 'import', 'remove', 'rename', 'test']);
  });
});
