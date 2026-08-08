import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMMAND_REQUEST_SCHEMA_VERSION,
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
import { runMetricMutationCommand } from './metric-command.js';

const EXEC_FIXTURE = fileURLToPath(new URL('./fixtures/result-metric.cjs', import.meta.url));
const temporaryDirectories: string[] = [];
const originalSecret = process.env.ATTEST_METRIC_SOURCE_SECRET;

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

const metricFixture = (output: unknown = { answer: 'Paris', score: 0.9 }) =>
  JSON.stringify({
    schema: METRIC_TEST_FIXTURE_SCHEMA_VERSION,
    case: { id: 'local-case', input: { question: 'Capital?' }, expected: 'Paris' },
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
    const listed = await runJson(root, ['metric', 'list']);
    expect(listed.document).toMatchObject({ ok: true, command: 'metric.list' });
    if (!listed.document.ok) throw new Error('Expected metric list success.');
    expect(
      (listed.document.result as { items: Array<{ id: string; kind: string }> }).items,
    ).toContainEqual(expect.objectContaining({ id: 'equals', kind: 'assertion' }));
    expect((await runJson(root, ['metric', 'show', 'regex'])).document).toMatchObject({
      ok: true,
      command: 'metric.show',
      result: { resource: { id: 'regex', definition: { kind: 'assertion' } } },
    });
  });

  it('keeps guided, flag, stdin, import, and from-json routes on canonical resources', async () => {
    const root = await createProject();
    const questions: string[] = [];
    const guided = collectIo();
    expect(
      await runCli(['metric', 'add'], {
        workingDirectory: root,
        io: guided.io,
        interaction: {
          ci: false,
          inputIsTTY: true,
          outputIsTTY: true,
          prompt: (question) => {
            questions.push(question);
            if (question === 'Metric id: ') return Promise.resolve('guided');
            if (question.startsWith('Preset')) return Promise.resolve('output-contains');
            if (question === 'JSON value: ') return Promise.resolve('"needle"');
            return Promise.resolve('yes');
          },
          readStdin: () => Promise.resolve(''),
        },
      }),
    ).toBe(0);
    expect(questions.at(-1)).toContain('Apply these changes? [y/N]');

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
    expect((await loadProject({ project: root })).metrics.map(({ id }) => id).sort()).toEqual([
      'guided',
      'imported',
      'judge',
      'requested',
    ]);
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
    const shown = await runJson(root, ['metric', 'show', 'http']);
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
    await expect(access(marker)).rejects.toThrow();

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
        code: 'invocation_failed',
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

  it('publishes exact JSON help and generated fixture/request schemas', async () => {
    const root = await createProject();
    const help = await runJson(root, ['help', 'metric', 'add']);
    expect(help.document).toMatchObject({ ok: true, command: 'help' });
    if (!help.document.ok) throw new Error('Expected metric help success.');
    const command = (
      help.document.result as {
        command: { options: Array<{ name: string }>; path: string[]; request_schema: string };
      }
    ).command;
    expect(command.path).toEqual(['metric', 'add']);
    expect(command.request_schema).toBe(COMMAND_REQUEST_SCHEMA_VERSION);
    expect(command.options.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['from-json', 'preset']),
    );
    expect(
      (await runJson(root, ['schema', 'print', METRIC_TEST_FIXTURE_SCHEMA_VERSION])).exitCode,
    ).toBe(0);
    expect(
      (await runJson(root, ['schema', 'print', COMMAND_REQUEST_SCHEMA_VERSION])).output,
    ).toContain('metric.test');
  });
});
