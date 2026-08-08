import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  COMMAND_REQUEST_SCHEMA_VERSION,
  METRIC_PRESETS,
  METRIC_RESOURCE_SCHEMA_VERSION,
  METRIC_TEST_FIXTURE_SCHEMA_VERSION,
  cliResultSchema,
  type CommandRequest,
  type MetricResource,
} from '@attest/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadProject } from '../../project/load-project.js';
import { applyProjectMutation } from '../../project/transaction/index.js';
import {
  candidateFromLoadedProject,
  writeFixtureProject,
} from '../../project/transaction/project-transaction.test-fixture.js';
import { runCli, type CliIo } from '../../run-cli.js';
import { REDACTED } from '../agent/native-agent-adapter.js';
import { runMetricMutationCommand, runMetricTestCommand } from './metric-command.js';

const EXEC_FIXTURE = fileURLToPath(new URL('./fixtures/result-metric.cjs', import.meta.url));
const PTY_FIXTURE = fileURLToPath(new URL('./fixtures/pty-metric-authoring.py', import.meta.url));
const CLI_PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI_BUILT = fileURLToPath(new URL('../../../dist/cli.js', import.meta.url));
const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const originalSecret = process.env.ATTEST_METRIC_SOURCE_SECRET;
const originalAmbientSecret = process.env.ATTEST_METRIC_AMBIENT_SECRET;

const collectIo = (): { errors: string[]; io: CliIo; output: string[] } => {
  const errors: string[] = [];
  const output: string[] = [];
  return {
    errors,
    output,
    io: { error: (message) => errors.push(message), output: (message) => output.push(message) },
  };
};

const nonInteractive = (stdin = '') => ({
  ci: false,
  inputIsTTY: false,
  outputIsTTY: false,
  prompt: (): Promise<string> => Promise.reject(new Error('prompt must not be called')),
  readStdin: (): Promise<string> => Promise.resolve(stdin),
});

/** Creates an empty project through the same public path used by terminal users. */
const createProject = async (): Promise<string> => {
  const parent = await mkdtemp(join(tmpdir(), 'attest-metric-command-'));
  temporaryDirectories.push(parent);
  const collected = collectIo();
  expect(
    await runCli(['project', 'init', 'demo', '--name', 'Demo', '--output', 'json'], {
      interaction: nonInteractive(),
      io: collected.io,
      workingDirectory: parent,
    }),
  ).toBe(0);
  return join(parent, 'demo');
};

const createReferencedProject = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'attest-metric-references-'));
  temporaryDirectories.push(root);
  await writeFixtureProject(root);
  const loaded = await loadProject({ project: root });
  const candidate = candidateFromLoadedProject(loaded);
  candidate.tests[0]!.cases.push({
    id: 'direct',
    input: {},
    metric_overrides: [{ metric_id: 'correct', threshold: 0.75 }],
  });
  candidate.datasets[0]!.cases[0]!.metric_overrides = [{ metric_id: 'correct' }];
  await applyProjectMutation({
    candidate,
    expectedProjectHash: loaded.projectHash,
    projectRoot: root,
  });
  return root;
};

const runJson = async (
  root: string,
  argv: string[],
  stdin = '',
): Promise<{
  document: ReturnType<typeof cliResultSchema.parse>;
  exitCode: number;
  output: string;
}> => {
  const collected = collectIo();
  const exitCode = await runCli([...argv, '--output', 'json'], {
    interaction: nonInteractive(stdin),
    io: collected.io,
    workingDirectory: root,
  });
  expect(collected.errors).toEqual([]);
  expect(collected.output).toHaveLength(1);
  const output = collected.output[0] ?? '';
  return {
    document: cliResultSchema.parse(JSON.parse(output) as unknown),
    exitCode,
    output,
  };
};

/** Runs the compiled CLI while retaining structured stdout from expected nonzero exits. */
const runBuiltCli = async (
  argv: readonly string[],
): Promise<{ exitCode: number; stderr: string; stdout: string }> =>
  new Promise((resolveRun, rejectRun) => {
    execFile(
      process.execPath,
      [CLI_BUILT, ...argv],
      { timeout: 12_000 },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== 'number') {
          rejectRun(error instanceof Error ? error : new Error('Compiled CLI execution failed.'));
          return;
        }
        resolveRun({ exitCode: typeof error?.code === 'number' ? error.code : 0, stderr, stdout });
      },
    );
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Extracts the controlled child environment keys without trusting arbitrary metric result JSON. */
const evaluationEnvironmentKeys = (
  document: ReturnType<typeof cliResultSchema.parse>,
): string[] => {
  if (!document.ok) throw new Error('Expected a successful metric result.');
  const value = (
    document.result as {
      evaluation?: { result?: { details?: { env_keys?: unknown } } };
    }
  ).evaluation?.result?.details?.env_keys;
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new Error('Expected metric environment key evidence.');
  }
  return value;
};

/** Captures sorted project bytes so zero-write and rollback checks include hidden journals. */
const snapshotTree = async (root: string, prefix = ''): Promise<Record<string, string>> => {
  const snapshot: Record<string, string> = {};
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    const relativePath = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(snapshot, await snapshotTree(root, relativePath));
    else snapshot[relativePath] = (await readFile(join(root, relativePath))).toString('base64');
  }
  return snapshot;
};

const metricFixture = (output: unknown = { answer: 'Paris', score: 0.9 }, expectedPass = true) =>
  JSON.stringify({
    schema: METRIC_TEST_FIXTURE_SCHEMA_VERSION,
    case: { id: 'local-case', input: { question: 'Capital?' }, expected: 'Paris' },
    expected_pass: expectedPass,
    output,
    trace: {
      schema: 'attest.trace/v1alpha1',
      trace_id: 'trace-local',
      spans: [
        {
          span_id: 'span-tool',
          parent_span_id: null,
          name: 'search',
          kind: 'tool',
          start_time: '2026-08-08T00:00:00Z',
          end_time: '2026-08-08T00:00:01Z',
          status: { code: 'ok' },
          attributes: { arguments: '{"query":"capital"}' },
        },
      ],
    },
  });

const assertionMetric = (id: string): MetricResource => ({
  schema: METRIC_RESOURCE_SCHEMA_VERSION,
  id,
  name: id,
  definition: {
    kind: 'assertion',
    assertions: [{ equals: { path: '$.output.answer', value: 'Paris' } }],
  },
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (originalSecret === undefined) delete process.env.ATTEST_METRIC_SOURCE_SECRET;
  else process.env.ATTEST_METRIC_SOURCE_SECRET = originalSecret;
  if (originalAmbientSecret === undefined) delete process.env.ATTEST_METRIC_AMBIENT_SECRET;
  else process.env.ATTEST_METRIC_AMBIENT_SECRET = originalAmbientSecret;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('CLI2.9 metric authoring and local tests', { timeout: 30_000 }, () => {
  it('authors every deterministic assertion through presets or complete assertion JSON', async () => {
    const root = await createProject();
    const commands: string[][] = [
      ['metric', 'add', 'equals', '--preset', 'output-equals', '--value', '"Paris"'],
      ['metric', 'add', 'contains', '--preset', 'output-contains', '--value', '"Par"'],
      [
        'metric',
        'add',
        'schema',
        '--preset',
        'output-schema',
        '--json-schema',
        '{"type":"object"}',
      ],
      ['metric', 'add', 'regex', '--path', '$.output.answer', '--pattern', '^Par', '--flags', 'i'],
      ['metric', 'add', 'threshold', '--path', '$.output.score', '--gte', '0.8'],
      ['metric', 'add', 'exists', '--path', '$.output.answer'],
      [
        'metric',
        'add',
        'tool',
        '--preset',
        'tool-called',
        '--tool',
        'search',
        '--count',
        '1',
        '--arg-contains',
        '$.query="cap"',
      ],
      ['metric', 'add', 'order', '--preset', 'tool-order', '--order', 'search'],
      ['metric', 'add', 'no-errors', '--preset', 'no-tool-errors'],
      [
        'metric',
        'add',
        'span',
        '--preset',
        'trace-span',
        '--span-kind',
        'tool',
        '--span-status',
        'ok',
        '--count',
        '1',
      ],
      [
        'metric',
        'add',
        'composition',
        '--assert-json',
        '{"all":[{"exists":{"path":"$.output"}},{"not":{"equals":{"path":"$.output","value":null}}}]}',
      ],
    ];
    for (const command of commands) expect((await runJson(root, command)).exitCode).toBe(0);

    const loaded = await loadProject({ project: root });
    expect(loaded.metrics).toHaveLength(commands.length);
    const composition = loaded.metrics.find(({ id }) => id === 'composition')?.definition;
    expect(composition?.kind).toBe('assertion');
    if (composition?.kind !== 'assertion') throw new Error('Expected assertion composition.');
    expect(composition.assertions[0]).toHaveProperty('all');
    const listed = await runJson(root, ['list', 'metrics']);
    expect(listed.document).toMatchObject({ ok: true, command: 'list' });
    if (!listed.document.ok) throw new Error('Expected metric list success.');
    expect(
      (listed.document.result as { items: Array<{ id: string; kind: string }> }).items,
    ).toContainEqual(expect.objectContaining({ id: 'equals', kind: 'assertion' }));
    expect((await runJson(root, ['show', 'metric', 'regex'])).document).toMatchObject({
      ok: true,
      command: 'show',
      result: { resource: { id: 'regex', definition: { kind: 'assertion' } } },
    });
    const okTraceFixture = join(root, 'ok-tools.json');
    await writeFile(okTraceFixture, metricFixture());
    expect(
      (await runJson(root, ['metric', 'test', 'no-errors', '--fixture', okTraceFixture])).document,
    ).toMatchObject({
      ok: true,
      result: { evaluation: { status: 'evaluated', result: { pass: true } } },
    });
    const mixedFixture = JSON.parse(metricFixture({}, false)) as {
      trace: { spans: Array<Record<string, unknown>> };
    };
    mixedFixture.trace.spans.push({
      span_id: 'span-error',
      parent_span_id: null,
      name: 'write',
      kind: 'tool',
      start_time: '2026-08-08T00:00:02Z',
      end_time: '2026-08-08T00:00:03Z',
      status: { code: 'error' },
      attributes: {},
    });
    const mixedTraceFixture = join(root, 'mixed-tools.json');
    await writeFile(mixedTraceFixture, JSON.stringify(mixedFixture));
    expect(
      (await runJson(root, ['metric', 'test', 'no-errors', '--fixture', mixedTraceFixture]))
        .document,
    ).toMatchObject({
      ok: true,
      result: { evaluation: { status: 'evaluated', result: { pass: false } } },
    });
  });

  it('keeps guided, flag, stdin, import, and from-json routes on canonical resources', async () => {
    const root = await createProject();
    expect(
      (
        await runJson(root, [
          'agent',
          'add',
          'traced',
          '--argv-json',
          JSON.stringify([process.execPath]),
          '--trace',
        ])
      ).exitCode,
    ).toBe(0);
    const questions: string[] = [];
    const guided = collectIo();
    const guidedExit = await runCli(['metric', 'add'], {
      workingDirectory: root,
      io: guided.io,
      interaction: {
        ci: false,
        inputIsTTY: true,
        outputIsTTY: true,
        prompt: (question) => {
          questions.push(question);
          if (question === 'Metric id: ') return Promise.resolve('guided');
          if (question.startsWith('Metric catalog')) return Promise.resolve('assertion');
          if (question.startsWith('Assertion evidence')) return Promise.resolve('expected');
          if (question.startsWith('Assertion operator')) return Promise.resolve('contains');
          if (question.includes('JSON value: ')) return Promise.resolve('"needle"');
          return Promise.resolve('yes');
        },
        readStdin: () => Promise.resolve(''),
      },
    });
    expect(guided.errors).toEqual([]);
    expect(guidedExit).toBe(0);
    expect(questions.at(-1)).toContain('Apply these changes? [y/N]');
    expect(questions[1]).toContain('attest.metric-preset/v1');
    expect(questions[1]).toContain('trace-capable fixture');
    expect(questions).toContain('Assertion evidence [output] (input|output|expected|trace): ');
    expect(questions).toContain(
      'Assertion operator for $.expected [equals] (equals|contains|json-schema|regex|exists|lt|lte|gt|gte): ',
    );
    expect(questions).toContain(
      'Assertion preview: evidence=$.expected; operator=contains.\nJSON value: ',
    );

    const defaultGuided = collectIo();
    expect(
      await runCli(['metric', 'add'], {
        workingDirectory: root,
        io: defaultGuided.io,
        interaction: {
          ci: false,
          inputIsTTY: true,
          outputIsTTY: true,
          prompt: (question) => {
            if (question === 'Metric id: ') return Promise.resolve('guided-default');
            if (question.startsWith('Metric catalog')) return Promise.resolve('');
            if (question.startsWith('Assertion evidence')) return Promise.resolve('');
            if (question.startsWith('Assertion operator')) return Promise.resolve('');
            if (question.includes('JSON value: ')) return Promise.resolve('null');
            return Promise.resolve('yes');
          },
          readStdin: () => Promise.resolve(''),
        },
      }),
    ).toBe(0);

    const traceQuestions: string[] = [];
    const traceGuided = collectIo();
    expect(
      await runCli(['metric', 'add', 'guided-trace'], {
        workingDirectory: root,
        io: traceGuided.io,
        interaction: {
          ci: false,
          inputIsTTY: true,
          outputIsTTY: true,
          prompt: (question) => {
            traceQuestions.push(question);
            if (question.startsWith('Metric catalog')) return Promise.resolve('assertion');
            if (question.startsWith('Assertion evidence')) return Promise.resolve('trace');
            if (question.startsWith('Agent trace capabilities')) return Promise.resolve('traced');
            if (question.includes('Trace operator')) return Promise.resolve('tool-called');
            if (question.includes('Tool name: ')) return Promise.resolve('search');
            return Promise.resolve('yes');
          },
          readStdin: () => Promise.resolve(''),
        },
      }),
    ).toBe(0);
    expect(traceQuestions.join('\n')).toContain('traced: advertises trace support');
    expect(traceQuestions.join('\n')).toContain(
      'Agent traced advertises trace support. Creation remains available before trace evidence exists.',
    );
    expect(traceQuestions).toContain(
      'Assertion preview: evidence=trace; operator=tool-called.\nTool name: ',
    );

    const requested = JSON.stringify({
      schema: COMMAND_REQUEST_SCHEMA_VERSION,
      command: 'metric.add',
      metric: assertionMetric('requested'),
    });
    expect((await runJson(root, ['metric', 'add', '--from-json', '-'], requested)).exitCode).toBe(
      0,
    );

    const imported = JSON.stringify(assertionMetric('source'));
    expect(
      (
        await runJson(
          root,
          ['metric', 'import', '-', '--type', 'json', '--as', 'imported'],
          imported,
        )
      ).exitCode,
    ).toBe(0);
    expect(
      (
        await runJson(
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
          'Judge correctness against expected output.',
        )
      ).exitCode,
    ).toBe(0);
    const loaded = await loadProject({ project: root });
    expect(loaded.metrics.map(({ id }) => id).sort()).toEqual([
      'guided',
      'guided-default',
      'guided-trace',
      'imported',
      'judge',
      'requested',
    ]);
    expect(loaded.metrics.find(({ id }) => id === 'guided')?.definition).toMatchObject({
      kind: 'assertion',
      assertions: [{ contains: { path: '$.expected', value: 'needle' } }],
    });
    expect(loaded.metrics.find(({ id }) => id === 'guided-trace')?.definition).toMatchObject({
      kind: 'assertion',
      assertions: [{ tool_calls: { name: 'search' } }],
    });
  });

  it('drives evidence, capability, operator, value, and preview through the packed CLI PTY', async () => {
    const root = await createProject();
    expect(
      (
        await runJson(root, [
          'agent',
          'add',
          'traced',
          '--argv-json',
          JSON.stringify([process.execPath]),
          '--trace',
        ])
      ).exitCode,
    ).toBe(0);
    await execFileAsync('bun', ['run', 'build'], { cwd: CLI_PACKAGE_ROOT, timeout: 30_000 });

    const literal = 'packed-camel-secret';
    const packedSecret = await runBuiltCli([
      'metric',
      'add',
      'packed-secret',
      '--preset',
      'http',
      '--url',
      'https://metric.example/evaluate',
      '--body-json',
      JSON.stringify({ accessToken: literal }),
      '--project',
      root,
      '--output',
      'json',
    ]);
    expect(packedSecret.exitCode).toBe(1);
    expect(packedSecret.stderr).toBe('');
    expect(packedSecret.stdout).not.toContain(literal);
    expect(cliResultSchema.parse(JSON.parse(packedSecret.stdout) as unknown)).toMatchObject({
      ok: false,
      command: 'metric.add',
      error: { code: 'project_invalid' },
    });

    const { stderr, stdout } = await execFileAsync(
      'python3',
      [PTY_FIXTURE, process.execPath, CLI_BUILT, 'metric', 'add', 'pty-trace', '--project', root],
      { timeout: 16_000 },
    );
    expect(stderr).toBe('');
    const ptyEvidence: unknown = JSON.parse(stdout);
    expect(isRecord(ptyEvidence)).toBe(true);
    if (!isRecord(ptyEvidence)) throw new Error('Expected structured metric PTY evidence.');
    expect(ptyEvidence).toMatchObject({
      exit_code: 0,
      prompts_seen: [true, true, true, true, true, true],
      terminal_restored: true,
    });
    expect(typeof ptyEvidence.output).toBe('string');
    if (typeof ptyEvidence.output !== 'string') throw new Error('Expected metric PTY output.');
    expect(ptyEvidence.output).toContain('traced: advertises trace support');
    expect(ptyEvidence.output).toContain('Assertion preview: evidence=trace; operator=tool-called');
    const ptyMetric = (await loadProject({ project: root })).metrics.find(
      ({ id }) => id === 'pty-trace',
    );
    expect(ptyMetric).toMatchObject({ id: 'pty-trace', definition: { kind: 'assertion' } });
  });

  it('round-trips judge, executable, and HTTP configs with secret references and redaction', async () => {
    const root = await createProject();
    process.env.ATTEST_METRIC_SOURCE_SECRET = 'metric-super-secret';
    expect(
      (
        await runJson(root, [
          'metric',
          'add',
          'exec',
          '--preset',
          'command',
          '--argv-json',
          JSON.stringify([process.execPath, EXEC_FIXTURE, 'redact']),
          '--env',
          'METRIC_SECRET=ATTEST_METRIC_SOURCE_SECRET',
          '--timeout',
          '5s',
        ])
      ).exitCode,
    ).toBe(0);
    expect(
      (
        await runJson(root, [
          'metric',
          'add',
          'http',
          '--preset',
          'http',
          '--url',
          'https://metric.example/evaluate',
          '--header-env',
          'Authorization=ATTEST_METRIC_SOURCE_SECRET',
          '--score-pointer',
          '/verdict/score',
          '--pass-pointer',
          '/verdict/pass',
        ])
      ).exitCode,
    ).toBe(0);
    const shown = await runJson(root, ['show', 'metric', 'http']);
    expect(shown.output).not.toContain('metric-super-secret');
    expect(shown.output).toContain('ATTEST_METRIC_SOURCE_SECRET');
    const loaded = await loadProject({ project: root });
    expect(loaded.metrics.find(({ id }) => id === 'exec')?.definition).toMatchObject({
      kind: 'exec',
      env: { METRIC_SECRET: { from_env: 'ATTEST_METRIC_SOURCE_SECRET' } },
      timeout_ms: 5_000,
    });
    expect(loaded.metrics.find(({ id }) => id === 'http')?.definition).toMatchObject({
      kind: 'http',
      extraction: { score_pointer: '/verdict/score', pass_pointer: '/verdict/pass' },
    });
  });

  it('tests assertions deterministically and trusted argv without shell interpretation or secret leaks', async () => {
    const root = await createProject();
    const fixturePath = join(root, 'fixture.json');
    await writeFile(fixturePath, metricFixture());
    await runJson(root, [
      'metric',
      'add',
      'exact',
      '--assert-json',
      '{"equals":{"path":"$.output.answer","value":"Paris"}}',
    ]);
    const first = await runJson(root, ['metric', 'test', 'exact', '--fixture', fixturePath]);
    const second = await runJson(root, ['metric', 'test', 'exact', '--fixture', fixturePath]);
    expect(first.output).toBe(second.output);
    expect(first.document).toMatchObject({
      ok: true,
      result: { executed: true, evaluation: { status: 'evaluated', result: { pass: true } } },
    });

    const mismatchPath = join(root, 'fixture-mismatch.json');
    await writeFile(mismatchPath, metricFixture({ answer: 'London' }, true));
    const mismatch = await runJson(root, ['metric', 'test', 'exact', '--fixture', mismatchPath]);
    expect(mismatch.exitCode).toBe(1);
    expect(mismatch.document).toMatchObject({
      ok: false,
      error: {
        code: 'metric_fixture_mismatch',
        details: { actual_pass: false, expected_pass: true },
      },
    });
    await writeFile(mismatchPath, metricFixture({ answer: 'London' }, false));
    expect(
      (await runJson(root, ['metric', 'test', 'exact', '--fixture', mismatchPath])).document,
    ).toMatchObject({
      ok: true,
      result: { evaluation: { status: 'evaluated', result: { pass: false } } },
    });
    const missingVerdict = JSON.parse(metricFixture()) as Record<string, unknown>;
    Reflect.deleteProperty(missingVerdict, 'expected_pass');
    await writeFile(mismatchPath, JSON.stringify(missingVerdict));
    expect(
      (await runJson(root, ['metric', 'test', 'exact', '--fixture', mismatchPath])).document,
    ).toMatchObject({ ok: false, error: { code: 'project_invalid', path: '--fixture' } });

    const marker = join(root, 'must-not-exist');
    process.env.ATTEST_METRIC_SOURCE_SECRET = 'metric-super-secret';
    await runJson(root, [
      'metric',
      'add',
      'local-exec',
      '--preset',
      'command',
      '--argv-json',
      JSON.stringify([process.execPath, EXEC_FIXTURE, 'redact', ';', 'touch', marker]),
      '--env',
      'METRIC_SECRET=ATTEST_METRIC_SOURCE_SECRET',
    ]);
    const tested = await runJson(root, ['metric', 'test', 'local-exec', '--fixture', fixturePath]);
    expect(tested.exitCode).toBe(0);
    expect(tested.output).not.toContain('metric-super-secret');
    expect(tested.output).toContain(REDACTED);
    expect(
      evaluationEnvironmentKeys(tested.document).filter((name) => !name.startsWith('__CF_')),
    ).toEqual(['LC_ALL', 'METRIC_SECRET', 'PATH', 'TMPDIR']);
    await expect(access(marker)).rejects.toThrow();

    process.env.ATTEST_METRIC_AMBIENT_SECRET = 'ambient-must-not-reach-child';
    await runJson(root, [
      'metric',
      'add',
      'isolated-env',
      '--preset',
      'command',
      '--argv-json',
      JSON.stringify([process.execPath, EXEC_FIXTURE, 'ambient']),
    ]);
    const isolated = await runJson(root, [
      'metric',
      'test',
      'isolated-env',
      '--fixture',
      fixturePath,
    ]);
    expect(isolated.output).toContain('ambient-absent');
    expect(isolated.output).not.toContain('ambient-must-not-reach-child');
    expect(
      evaluationEnvironmentKeys(isolated.document).filter((name) => !name.startsWith('__CF_')),
    ).toEqual(['LC_ALL', 'PATH', 'TMPDIR']);

    await runJson(root, [
      'metric',
      'add',
      'token-counter',
      '--preset',
      'command',
      '--argv-json',
      JSON.stringify([process.execPath, EXEC_FIXTURE, 'pass', '--max-tokens', '100']),
    ]);
    expect(
      (await runJson(root, ['metric', 'test', 'token-counter', '--fixture', fixturePath])).exitCode,
    ).toBe(0);

    await runJson(root, [
      'metric',
      'add',
      'broken-exec',
      '--preset',
      'command',
      '--argv-json',
      '["attest-metric-command-that-does-not-exist"]',
    ]);
    const failed = await runJson(root, ['metric', 'test', 'broken-exec', '--fixture', fixturePath]);
    expect(failed.exitCode).toBe(4);
    expect(failed.document).toMatchObject({
      ok: false,
      error: {
        code: 'metric_infrastructure_failed',
        details: { evaluation: { status: 'error', error: { code: 'exec_spawn_failed' } } },
      },
    });
  });

  it('validates judge and HTTP fixtures without starting provider or network execution', async () => {
    const root = await createProject();
    const fixturePath = join(root, 'fixture.json');
    await writeFile(fixturePath, metricFixture());
    await runJson(root, [
      'metric',
      'add',
      'judge',
      '--preset',
      'judge-rubric',
      '--model',
      'openai/gpt-5',
      '--rubric',
      'Be correct.',
    ]);
    await runJson(root, [
      'metric',
      'add',
      'http',
      '--preset',
      'http',
      '--url',
      'https://network-must-not-run.example/metric',
    ]);
    const fetchSpy = vi.fn(() => Promise.reject(new Error('network execution is forbidden')));
    vi.stubGlobal('fetch', fetchSpy);
    for (const id of ['judge', 'http']) {
      expect(
        (await runJson(root, ['metric', 'test', id, '--fixture', fixturePath])).document,
      ).toMatchObject({
        ok: true,
        result: {
          metric_id: id,
          fixture_valid: true,
          executed: false,
          reason: 'external_execution_not_supported',
        },
      });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects executable cwd symlinks that escape the descriptor-checked project root', async () => {
    const root = await createProject();
    const outside = await mkdtemp(join(tmpdir(), 'attest-metric-cwd-outside-'));
    temporaryDirectories.push(outside);
    await symlink(outside, join(root, 'linkout'));
    const fixturePath = join(root, 'fixture.json');
    await writeFile(fixturePath, metricFixture());
    expect(
      (
        await runJson(root, [
          'metric',
          'add',
          'escaped-cwd',
          '--preset',
          'command',
          '--argv-json',
          JSON.stringify([process.execPath, EXEC_FIXTURE]),
          '--cwd',
          'linkout',
        ])
      ).exitCode,
    ).toBe(0);
    const tested = await runJson(root, ['metric', 'test', 'escaped-cwd', '--fixture', fixturePath]);
    expect(tested.exitCode).toBe(1);
    expect(tested.document).toMatchObject({
      ok: false,
      error: { code: 'project_invalid', message: 'Metric cwd is not a safe project directory.' },
    });

    const anchoredPath = join(root, 'anchored-cwd');
    await mkdir(anchoredPath);
    await runJson(root, [
      'metric',
      'add',
      'replaced-cwd',
      '--preset',
      'command',
      '--argv-json',
      JSON.stringify([process.execPath, EXEC_FIXTURE]),
      '--cwd',
      'anchored-cwd',
    ]);
    await expect(
      runMetricTestCommand({
        cwdObserver: async (path) => {
          await rename(path, `${path}-replaced`);
          await mkdir(path);
        },
        fixture: fixturePath,
        metricId: 'replaced-cwd',
        project: root,
        readStdin: () => Promise.resolve(''),
        workingDirectory: root,
      }),
    ).rejects.toMatchObject({
      code: 'project_invalid',
      message: 'Metric cwd is not a safe project directory.',
    });
  });

  it('renames every reference and requires explicit detach before referenced removal', async () => {
    const root = await createReferencedProject();
    const blocked = await runJson(root, ['metric', 'remove', 'correct', '--yes']);
    expect(blocked.exitCode).toBe(1);
    expect(blocked.document).toMatchObject({ ok: false, error: { code: 'project_invalid' } });
    if (blocked.document.ok) throw new Error('Expected referenced metric removal failure.');
    expect(
      (blocked.document.error.details as { reference_paths: unknown[] }).reference_paths,
    ).toHaveLength(3);

    expect((await runJson(root, ['metric', 'rename', 'correct', 'correctness'])).exitCode).toBe(0);
    let loaded = await loadProject({ project: root });
    expect(loaded.tests[0]?.metrics[0]?.metric_id).toBe('correctness');
    expect(loaded.tests[0]?.cases[0]?.metric_overrides?.[0]?.metric_id).toBe('correctness');
    expect(loaded.datasets[0]?.cases[0]?.metric_overrides?.[0]?.metric_id).toBe('correctness');

    expect(
      (await runJson(root, ['metric', 'remove', 'correctness', '--detach', '--yes'])).exitCode,
    ).toBe(0);
    loaded = await loadProject({ project: root });
    expect(loaded.metrics).toEqual([]);
    expect(loaded.tests[0]?.metrics).toEqual([]);
    expect(loaded.tests[0]?.cases[0]?.metric_overrides).toEqual([]);
    expect(loaded.datasets[0]?.cases[0]?.metric_overrides).toEqual([]);
  });

  it('keeps dry runs, stale hashes, and publication failures byte-for-byte write-free', async () => {
    const root = await createProject();
    const before = await snapshotTree(root);
    const loaded = await loadProject({ project: root });
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
      loaded.projectHash,
    ]);
    expect(preview.document).toMatchObject({
      ok: true,
      result: { committed: false, dry_run: true },
    });
    expect(await snapshotTree(root)).toEqual(before);

    const conflict = await runJson(root, [
      'metric',
      'add',
      'conflict',
      '--preset',
      'output-equals',
      '--value',
      'null',
      '--if-project-hash',
      'a'.repeat(64),
    ]);
    expect(conflict.exitCode).toBe(3);
    expect(conflict.document).toMatchObject({ ok: false, error: { code: 'project_changed' } });
    expect(await snapshotTree(root)).toEqual(before);

    await expect(
      runMetricMutationCommand({
        interactive: false,
        project: root,
        publishObserver: () => {
          throw new Error('injected publication failure');
        },
        readStdin: () => Promise.resolve(''),
        request: {
          schema: COMMAND_REQUEST_SCHEMA_VERSION,
          command: 'metric.add',
          metric: assertionMetric('rollback'),
        },
        workingDirectory: root,
      }),
    ).rejects.toMatchObject({ code: 'project_transaction_failed' });
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('returns strict missing-input and overlapping-source errors without writing', async () => {
    const root = await createProject();
    const before = await snapshotTree(root);
    expect((await runJson(root, ['metric', 'add', 'missing'])).document).toMatchObject({
      ok: false,
      error: { code: 'cli_missing_input', path: '--preset' },
    });
    const requestPath = join(root, 'request.json');
    const request: Extract<CommandRequest, { command: 'metric.add' }> = {
      schema: COMMAND_REQUEST_SCHEMA_VERSION,
      command: 'metric.add',
      metric: assertionMetric('requested'),
    };
    await writeFile(requestPath, JSON.stringify(request));
    const withInput = await snapshotTree(root);
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
    expect(overlap.document).toMatchObject({ ok: false, error: { code: 'cli_usage' } });
    expect(await snapshotTree(root)).toEqual(withInput);

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
      error: {
        code: 'cli_usage',
        details: { incompatible_flags: ['--url'] },
      },
    });
    expect(await snapshotTree(root)).toEqual(withInput);
    expect(before['attest.project.json']).toBe(withInput['attest.project.json']);
  });

  it('applies identical secret safety to flags, stdin import, and from-json requests', async () => {
    const root = await createProject();
    const before = await snapshotTree(root);
    const bodySecrets = {
      accessToken: 'literal-camel-access-secret',
      apiKey: 'literal-camel-api-secret',
      authToken: 'literal-camel-auth-secret',
    } as const;
    const unsafeHttp: MetricResource = {
      schema: METRIC_RESOURCE_SCHEMA_VERSION,
      id: 'unsafe-http',
      name: 'Unsafe HTTP',
      definition: {
        kind: 'http',
        request: {
          method: 'POST',
          url: 'https://metric.example/evaluate',
          body: { apiKey: bodySecrets.apiKey },
        },
        extraction: { score_pointer: '/score', pass_pointer: '/pass' },
      },
    };
    const flag = await runJson(root, [
      'metric',
      'add',
      'flag-secret',
      '--preset',
      'http',
      '--url',
      'https://metric.example/evaluate',
      '--body-json',
      JSON.stringify({ accessToken: bodySecrets.accessToken }),
    ]);
    const imported = await runJson(
      root,
      ['metric', 'import', '-', '--type', 'json', '--as', 'import-secret'],
      JSON.stringify(unsafeHttp),
    );
    const requested = await runJson(
      root,
      ['metric', 'add', '--from-json', '-'],
      JSON.stringify({
        schema: COMMAND_REQUEST_SCHEMA_VERSION,
        command: 'metric.add',
        metric: {
          ...unsafeHttp,
          id: 'request-secret',
          definition: {
            ...unsafeHttp.definition,
            request: {
              method: 'POST',
              url: 'https://metric.example/evaluate',
              body: { nested: { authToken: bodySecrets.authToken } },
            },
          },
        },
      }),
    );
    const unsafeExec = await runJson(
      root,
      ['metric', 'add', '--from-json', '-'],
      JSON.stringify({
        schema: COMMAND_REQUEST_SCHEMA_VERSION,
        command: 'metric.add',
        metric: {
          schema: METRIC_RESOURCE_SCHEMA_VERSION,
          id: 'exec-secret',
          name: 'Exec secret',
          definition: {
            kind: 'exec',
            argv: [process.execPath, EXEC_FIXTURE, '--api-key', 'literal-exec-secret'],
          },
        },
      }),
    );
    for (const result of [flag, imported, requested, unsafeExec]) {
      expect(result.exitCode).toBe(1);
      expect(result.document).toMatchObject({ ok: false, error: { code: 'project_invalid' } });
      for (const secret of Object.values(bodySecrets)) expect(result.output).not.toContain(secret);
      expect(result.output).not.toContain('literal-exec-secret');
    }
    expect(unsafeExec.document).toMatchObject({
      ok: false,
      error: { path: '/metric/definition/argv/3' },
    });
    expect(await snapshotTree(root)).toEqual(before);
    const shown = await runJson(root, ['show', 'metric', 'unsafe-http']);
    for (const secret of Object.values(bodySecrets)) expect(shown.output).not.toContain(secret);
  });

  it('publishes exact JSON help and generated fixture/request schemas', async () => {
    const root = await createProject();
    const help = await runJson(root, ['help', 'metric', 'add']);
    expect(help.document).toMatchObject({ ok: true, command: 'help' });
    if (!help.document.ok) throw new Error('Expected metric help success.');
    const command = (
      help.document.result as {
        command: {
          options: Array<{ name: string; repeatable: boolean }>;
          path: string[];
          presets?: unknown;
          request_schema: string;
        };
      }
    ).command;
    expect(command.path).toEqual(['metric', 'add']);
    expect(command.request_schema).toBe(COMMAND_REQUEST_SCHEMA_VERSION);
    expect(command.options.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['from-json', 'preset']),
    );
    expect(command.presets).toEqual(METRIC_PRESETS);
    const repeatability = new Map(
      command.options.map(({ name, repeatable }) => [name, repeatable]),
    );
    expect(
      [...repeatability.entries()]
        .filter(([, repeatable]) => repeatable)
        .map(([name]) => name)
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
    const metricHelp = await runJson(root, ['help', 'metric']);
    expect(metricHelp.document).toMatchObject({
      ok: true,
      result: {
        command: {
          subcommands: [
            { name: 'add', aliases: [], alias_for: null },
            { name: 'import', aliases: [], alias_for: null },
            { name: 'remove', aliases: [], alias_for: null },
            { name: 'rename', aliases: [], alias_for: null },
            { name: 'test', aliases: [], alias_for: null },
          ],
        },
      },
    });
    for (const removed of ['list', 'show']) {
      const removedHelp = await runJson(root, ['help', 'metric', removed]);
      expect(removedHelp.exitCode).toBe(2);
      expect(removedHelp.document).toMatchObject({
        ok: false,
        command: 'help',
        error: { code: 'cli_usage', path: `metric.${removed}` },
      });
    }
    expect(
      (await runJson(root, ['schema', 'print', METRIC_TEST_FIXTURE_SCHEMA_VERSION])).exitCode,
    ).toBe(0);
    expect(
      (await runJson(root, ['schema', 'print', COMMAND_REQUEST_SCHEMA_VERSION])).output,
    ).toContain('metric.test');
  });
});
