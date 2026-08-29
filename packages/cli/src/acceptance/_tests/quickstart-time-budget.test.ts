import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

type CommandExpectation = {
  acceptance_stdout?: string[];
  argv: string[];
  artifacts_absent?: string[];
  artifacts_present?: string[];
  capture_run_id?: boolean;
  catalog_error_code?: string;
  command?: string;
  error_code?: string;
  exit_code: number;
  help_arguments?: string[];
  help_usage?: string;
  id: string;
  no_write?: boolean;
  output: 'human' | 'json' | 'jsonl';
  readiness_probe?: 'view';
  required_error_fields?: string[];
  required_stdout?: string[];
  result_schema?: string;
};

type Actor = {
  commands: CommandExpectation[];
  description: string;
  id: string;
};

type Contract = {
  actors: Actor[];
  budget_ms: number;
  cross_platform: {
    node_major: number;
    required_ci_operating_systems: string[];
    rules: string[];
    windows_required: boolean;
  };
  fixture_files: string[];
  per_command_timeout_ms: number;
  prerequisites: { cold: string[]; warm: string[] };
  schema: string;
  timing: {
    aggregation: string;
    clock: string;
    excluded: string[];
    included: string[];
    retries: number;
    start: string;
    stop: string;
  };
};

type CliDocument = {
  command?: string;
  error?: Record<string, unknown> & { code?: string };
  ok?: boolean;
  result?: Record<string, unknown> & { schema?: string };
  schema?: string;
};

type CliEvent = {
  data?: {
    exit_code?: number;
    result?: CliDocument;
    run_id?: string;
  };
  event?: string;
  schema?: string;
  sequence?: number;
};

type CommandResult = {
  elapsedMs: number;
  exitCode: number;
  readiness?: {
    body: string;
    status: number;
    url: string;
  };
  stderr: string;
  stdout: string;
};

type FileSnapshot = Map<string, string>;

type PackedCli = {
  cliPath: string;
  root: string;
};

type JourneyEvidence = {
  actor: string;
  elapsedMs: number;
  gaps: string[];
  stepMilliseconds: Record<string, number>;
};

const execFileAsync = promisify(execFile);
const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(TEST_DIRECTORY, '../../../../..');
const CONTRACT_PATH = join(TEST_DIRECTORY, 'fixtures/quickstart-time-budget.json');
const FIXTURE_ROOT = join(TEST_DIRECTORY, 'fixtures/quickstart');
const CI_WORKFLOW_PATH = join(REPOSITORY_ROOT, '.github/workflows/ci.yml');
const PACKED_PACKAGE_ROOTS = [
  'packages/contracts',
  'packages/core',
  'packages/web',
  'packages/cli',
] as const;
const PACKED_PACKAGE_NAMES = [
  '@attest/cli',
  '@attest/contracts',
  '@attest/core',
  '@attest/web',
] as const;
const RUN_ID_PATTERN = /\b[0-9A-HJKMNP-TV-Z]{26}\b/u;
const temporaryDirectories: string[] = [];
const claimedPackedRuntimeRoots = new Set<string>();

/** Reads the task-owned acceptance contract without importing production contracts. */
const readContract = async (): Promise<Contract> =>
  JSON.parse(await readFile(CONTRACT_PATH, 'utf8')) as Contract;

/** Hashes every file under a clean actor root so read-only and failed commands prove zero writes. */
const snapshotFiles = async (root: string): Promise<FileSnapshot> => {
  const snapshot: FileSnapshot = new Map();
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(root, absolutePath).split(sep).join('/');
      if (entry.isDirectory()) {
        // Directory entries catch empty lock, transaction, or artifact residue after no-write steps.
        snapshot.set(`${relativePath}/`, '<directory>');
        await visit(absolutePath);
      } else if (entry.isFile()) {
        snapshot.set(
          relativePath,
          createHash('sha256')
            .update(await readFile(absolutePath))
            .digest('hex'),
        );
      } else {
        throw new Error(`Unsupported acceptance fixture entry ${relativePath}.`);
      }
    }
  };
  await visit(root);
  return snapshot;
};

/** Creates the production-packed CLI prerequisite outside the measured actor stopwatch. */
const createPackedCli = async (): Promise<PackedCli> => {
  await execFileAsync('bun', ['run', 'build'], { cwd: REPOSITORY_ROOT, timeout: 120_000 });
  const runtime = await mkdtemp(join(tmpdir(), 'attest-quickstart-packed-'));
  temporaryDirectories.push(runtime);
  const archiveDirectory = join(runtime, 'archives');
  await mkdir(archiveDirectory);
  const archivePaths: Record<string, string> = {};

  for (const packageRoot of PACKED_PACKAGE_ROOTS) {
    const { stdout } = await execFileAsync(
      'bun',
      ['pm', 'pack', '--quiet', '--destination', archiveDirectory],
      { cwd: join(REPOSITORY_ROOT, packageRoot), encoding: 'utf8', timeout: 30_000 },
    );
    const archivePath = resolve(stdout.trim());
    const { stdout: manifestJson } = await execFileAsync(
      'tar',
      ['-xOf', archivePath, 'package/package.json'],
      { encoding: 'utf8', timeout: 30_000 },
    );
    const packageName = (JSON.parse(manifestJson) as { name?: string }).name;
    if (packageName === undefined || !PACKED_PACKAGE_NAMES.includes(packageName as never)) {
      throw new Error(`Unexpected packed package ${String(packageName)}.`);
    }
    archivePaths[packageName] = archivePath;
  }

  const archiveReference = (packageName: (typeof PACKED_PACKAGE_NAMES)[number]): string =>
    `./archives/${basename(archivePaths[packageName] ?? '')}`;
  const manifest = {
    private: true,
    dependencies: { '@attest/cli': archiveReference('@attest/cli') },
    overrides: {
      '@attest/contracts': archiveReference('@attest/contracts'),
      '@attest/core': archiveReference('@attest/core'),
      '@attest/web': archiveReference('@attest/web'),
    },
  };
  await writeFile(join(runtime, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await execFileAsync(
    'bun',
    [
      'install',
      '--production',
      '--ignore-scripts',
      '--no-save',
      // The frozen repository install primes Bun's cache; offline mode forbids registry access.
      '--offline',
    ],
    { cwd: runtime, timeout: 120_000 },
  );

  const cliPath = join(runtime, 'node_modules/.bin/attest');
  await access(cliPath, constants.X_OK);
  const installedRoot = await realpath(join(runtime, 'node_modules/@attest/cli'));
  expect(installedRoot.startsWith(`${await realpath(runtime)}${sep}`)).toBe(true);
  expect(installedRoot.startsWith(`${await realpath(REPOSITORY_ROOT)}${sep}`)).toBe(false);
  return { cliPath, root: runtime };
};

/** Starts the long-running view command, proves loopback readiness, then stops it cleanly. */
const runViewReadinessProbe = async (
  packed: PackedCli,
  argv: readonly string[],
  workingDirectory: string,
  timeout: number,
): Promise<CommandResult> => {
  const started = performance.now();
  const child = spawn(process.execPath, ['--no-warnings', packed.cliPath, ...argv], {
    cwd: workingDirectory,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let elapsedMs = 0;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const readinessUrl = await new Promise<string>((resolveReadiness, rejectReadiness) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectReadiness(new Error(`View readiness exceeded ${String(timeout)}ms.`));
    }, timeout);
    const finish = (action: () => void): void => {
      clearTimeout(timer);
      action();
    };
    child.once('error', (error) => finish(() => rejectReadiness(error)));
    child.once('exit', (code, signal) => {
      if (elapsedMs === 0) {
        finish(() =>
          rejectReadiness(
            new Error(`View exited before readiness with ${String(code ?? signal)}.`),
          ),
        );
      }
    });
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const match = stdout.match(/Attest view: (http:\/\/127\.0\.0\.1:\d+\/#token=\S+)/u);
      if (match?.[1] !== undefined && elapsedMs === 0) {
        // Only process startup through the ready signal belongs to the frozen CLI interval.
        elapsedMs = performance.now() - started;
        finish(() => resolveReadiness(match[1]!));
      }
    });
  });

  let readiness: CommandResult['readiness'];
  try {
    // HTTP parsing and body assertions are harness instrumentation outside the measured interval.
    const response = await fetch(readinessUrl);
    readiness = { body: await response.text(), status: response.status, url: readinessUrl };
  } finally {
    child.kill('SIGINT');
    const forceStop = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await exited;
    clearTimeout(forceStop);
  }
  return { elapsedMs, exitCode: child.exitCode ?? 1, readiness, stderr, stdout };
};

/** Executes one installed CLI command and times only its process interval. */
const runCommand = async (
  packed: PackedCli,
  argv: readonly string[],
  workingDirectory: string,
  timeout: number,
  readinessProbe?: CommandExpectation['readiness_probe'],
): Promise<CommandResult> => {
  if (readinessProbe === 'view') {
    return runViewReadinessProbe(packed, argv, workingDirectory, timeout);
  }
  const started = performance.now();
  try {
    const result = await execFileAsync(
      process.execPath,
      ['--no-warnings', packed.cliPath, ...argv],
      {
        cwd: workingDirectory,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        timeout,
      },
    );
    return {
      elapsedMs: performance.now() - started,
      exitCode: 0,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  } catch (error: unknown) {
    const failure = error as { code?: number; stderr?: string; stdout?: string };
    return {
      elapsedMs: performance.now() - started,
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
      stderr: failure.stderr ?? '',
      stdout: failure.stdout ?? '',
    };
  }
};

/** Parses one JSONL eval stream and verifies sequence, terminal result, and exit parity. */
const parseEvalStream = (stdout: string, expectedExitCode: number): CliDocument => {
  const events = stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as CliEvent);
  expect(events.length).toBeGreaterThanOrEqual(3);
  expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index));
  for (const event of events) expect(event.schema).toBe('attest.cli-event');
  const terminal = events.at(-1);
  expect(terminal).toMatchObject({ event: 'result', data: { exit_code: expectedExitCode } });
  const document = terminal?.data?.result;
  if (document === undefined) throw new Error('Eval JSONL stream omitted its terminal result.');
  return document;
};

/** Replaces only runtime values captured from earlier structured or human output. */
const materialize = (value: string, runId: string | undefined): string => {
  if (!value.includes('$RUN_ID')) return value;
  if (runId === undefined) throw new Error('A command referenced $RUN_ID before eval completion.');
  return value.replaceAll('$RUN_ID', runId);
};

/** Verifies one command's output, filesystem contract, and optional dynamic run-id capture. */
const assertCommand = async (
  expectation: CommandExpectation,
  result: CommandResult,
  root: string,
  before: FileSnapshot,
  priorRunId: string | undefined,
  acceptanceGaps: string[],
): Promise<string | undefined> => {
  expect(result.exitCode, `${expectation.id}: ${result.stderr || result.stdout}`).toBe(
    expectation.exit_code,
  );
  expect(result.stderr, expectation.id).toBe('');

  let document: CliDocument | undefined;
  if (expectation.output === 'json') document = JSON.parse(result.stdout.trim()) as CliDocument;
  if (expectation.output === 'jsonl') {
    document = parseEvalStream(result.stdout, expectation.exit_code);
  }
  if (document !== undefined) {
    expect(document.schema, expectation.id).toBe('attest.cli-result');
    if (expectation.command !== undefined) {
      expect(document.command, expectation.id).toBe(expectation.command);
    }
    if (expectation.error_code !== undefined) {
      expect(document.error?.code, expectation.id).toBe(expectation.error_code);
    }
    for (const field of expectation.required_error_fields ?? []) {
      expect(document.error, `${expectation.id}: error.${field}`).toHaveProperty(field);
    }
    if (expectation.result_schema === 'run') {
      expect(document.result, expectation.id).toMatchObject({ resource_type: 'run' });
    } else if (expectation.result_schema !== undefined) {
      expect(document.result?.schema, expectation.id).toBe(expectation.result_schema);
    }
    if (expectation.catalog_error_code !== undefined) {
      const errors = document.result?.errors as Array<{ code?: string; repairs?: string[] }>;
      const catalogEntry = errors.find(({ code }) => code === expectation.catalog_error_code);
      expect(catalogEntry?.repairs?.length, expectation.id).toBeGreaterThan(0);
    }
    if (expectation.help_usage !== undefined) {
      const helpCommand = document.result?.command as
        { arguments?: Array<{ name?: string }>; usage?: string } | undefined;
      expect(helpCommand?.usage, expectation.id).toBe(expectation.help_usage);
      expect(
        helpCommand?.arguments?.map(({ name }) => name),
        `${expectation.id}: registered arguments`,
      ).toEqual(expectation.help_arguments);
    }
  }

  let runId = priorRunId;
  if (expectation.capture_run_id === true) {
    const candidate =
      expectation.output === 'human'
        ? result.stdout.match(RUN_ID_PATTERN)?.[0]
        : (document?.result?.run_id as string | undefined);
    expect(candidate, expectation.id).toMatch(RUN_ID_PATTERN);
    runId = candidate;
  }
  for (const required of expectation.required_stdout ?? []) {
    expect(result.stdout, `${expectation.id}: ${required}`).toContain(materialize(required, runId));
  }
  for (const required of expectation.acceptance_stdout ?? []) {
    const materialized = materialize(required, runId);
    if (!result.stdout.includes(materialized)) {
      acceptanceGaps.push(`${expectation.id} stdout omitted ${materialized}`);
    }
  }
  if (expectation.readiness_probe === 'view') {
    expect(result.readiness?.url, expectation.id).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=/u);
    expect(result.readiness?.status, expectation.id).toBe(200);
    expect(result.readiness?.body, expectation.id).toContain('<!doctype html>');
  }

  const after = await snapshotFiles(root);
  if (expectation.no_write === true) expect(after, expectation.id).toEqual(before);
  for (const path of expectation.artifacts_present ?? []) {
    const materializedPath = materialize(path, runId);
    await expect(
      access(join(root, materializedPath)),
      `${expectation.id}: ${materializedPath}`,
    ).resolves.toBeUndefined();
    if (materializedPath.endsWith('.html')) {
      const report = await readFile(join(root, materializedPath), 'utf8');
      expect(report, expectation.id).toContain('<!doctype html>');
      expect(report, expectation.id).toContain(runId);
    }
  }
  for (const path of expectation.artifacts_absent ?? []) {
    const materializedPath = materialize(path, runId);
    await expect(
      access(join(root, materializedPath)),
      `${expectation.id}: ${materializedPath}`,
    ).rejects.toMatchObject({ code: 'ENOENT' });
  }
  return runId;
};

/** Runs one cold actor journey and returns stopwatch evidence without averaging actors or OSes. */
const runJourney = async (actor: Actor, contract: Contract): Promise<JourneyEvidence> => {
  const packed = await createPackedCli();
  expect(claimedPackedRuntimeRoots.has(packed.root), `${actor.id}: packed runtime reused`).toBe(
    false,
  );
  claimedPackedRuntimeRoots.add(packed.root);
  const root = await mkdtemp(join(tmpdir(), `attest-quickstart-${actor.id}-`));
  temporaryDirectories.push(root);
  await cp(FIXTURE_ROOT, root, { recursive: true });
  const fixtureSnapshot = await snapshotFiles(root);
  expect([...fixtureSnapshot.keys()].sort()).toEqual([...contract.fixture_files].sort());
  for (const forbidden of ['attest.project.json', 'attest/', '.attest/', 'artifacts/']) {
    expect([...fixtureSnapshot.keys()].some((path) => path.startsWith(forbidden))).toBe(false);
  }

  let runId: string | undefined;
  const acceptanceGaps: string[] = [];
  const stepMilliseconds: Record<string, number> = {};
  for (const command of actor.commands) {
    const argv = command.argv.map((argument) => materialize(argument, runId));
    const before = await snapshotFiles(root);
    const result = await runCommand(
      packed,
      argv,
      root,
      contract.per_command_timeout_ms,
      command.readiness_probe,
    );
    stepMilliseconds[command.id] = result.elapsedMs;
    runId = await assertCommand(command, result, root, before, runId, acceptanceGaps);
  }
  const elapsedMs = Object.values(stepMilliseconds).reduce((total, elapsed) => total + elapsed, 0);

  // Inputs represent pre-existing user assets; the CLI must never rewrite them.
  const finalSnapshot = await snapshotFiles(root);
  for (const [path, hash] of fixtureSnapshot) expect(finalSnapshot.get(path), path).toBe(hash);
  expect(
    [...finalSnapshot.keys()].some((path) => /attest\.config\.(?:json|ya?ml)$/u.test(path)),
  ).toBe(false);
  expect([...finalSnapshot.keys()].some((path) => /\.ya?ml$/u.test(path))).toBe(false);
  expect(elapsedMs, `${actor.id}: instrumentation entered stopwatch`).toBe(
    Object.values(stepMilliseconds).reduce((total, elapsed) => total + elapsed, 0),
  );
  expect(elapsedMs, `${actor.id}: ${JSON.stringify(stepMilliseconds)}`).toBeLessThanOrEqual(
    contract.budget_ms,
  );
  return { actor: actor.id, elapsedMs, gaps: acceptanceGaps, stepMilliseconds };
};

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

describe('under-five-minute acceptance contract', () => {
  it('freezes exact timing, prerequisite, fixture, and cross-platform rules', async () => {
    const contract = await readContract();
    expect(contract.schema).toBe('attest.acceptance.quickstart');
    expect(contract.budget_ms).toBe(300_000);
    expect(contract.per_command_timeout_ms).toBe(30_000);
    expect(contract.timing).toMatchObject({
      aggregation:
        'Sum only the independently measured CLI process intervals for each actor; each actor must pass independently on every required operating system, and averages or pooled times are forbidden.',
      clock: 'performance.now monotonic wall time',
      retries: 0,
    });
    expect(contract.timing.excluded).toContain(
      'Snapshot hashing, structured-output parsing, HTML and readiness reads, process cleanup, and test assertions performed outside each CLI interval',
    );
    expect(contract.timing.included.length).toBeGreaterThanOrEqual(3);
    expect(contract.timing.excluded.length).toBeGreaterThanOrEqual(3);
    expect(contract.prerequisites.warm.length).toBeGreaterThanOrEqual(4);
    expect(contract.prerequisites.cold.length).toBeGreaterThanOrEqual(4);
    expect(contract.actors.map(({ id }) => id)).toEqual([
      'human-copy-paste',
      'coding-agent-non-interactive',
    ]);
    const human = contract.actors.find(({ id }) => id === 'human-copy-paste');
    expect(human?.commands.find(({ id }) => id === 'run-eval')?.acceptance_stdout).not.toContain(
      'attest diff',
    );
    expect(human?.commands.find(({ id }) => id === 'validate-comparison-template')).toMatchObject({
      argv: ['help', 'diff', '--output', 'json'],
      help_arguments: ['base-run-id', 'candidate-run-id'],
    });
    expect(human?.commands.find(({ id }) => id === 'write-report')?.argv).toEqual([
      'report',
      '$RUN_ID',
    ]);
    expect(human?.commands.find(({ id }) => id === 'open-view')).toMatchObject({
      argv: ['view', '--no-open'],
      readiness_probe: 'view',
    });

    const workflow = await readFile(CI_WORKFLOW_PATH, 'utf8');
    for (const operatingSystem of contract.cross_platform.required_ci_operating_systems) {
      expect(workflow).toContain(operatingSystem);
    }
    expect(workflow).toContain(`node-version: ${contract.cross_platform.node_major}`);
    expect(contract.cross_platform).toMatchObject({ windows_required: false });
    for (const fixture of contract.fixture_files) {
      await expect(access(join(FIXTURE_ROOT, fixture)), fixture).resolves.toBeUndefined();
    }
    for (const actor of contract.actors) {
      expect(actor.commands.some(({ id }) => id === 'discover')).toBe(true);
      expect(actor.commands.some(({ id }) => id.includes('agent'))).toBe(true);
      expect(actor.commands.some(({ id }) => id.includes('import'))).toBe(true);
      expect(actor.commands.some(({ id }) => id.includes('metric'))).toBe(true);
      expect(actor.commands.some(({ id }) => id === 'run-eval')).toBe(true);
      expect(actor.commands.some(({ id }) => id === 'inspect-run')).toBe(true);
      expect(actor.commands.some(({ id }) => id === 'structured-failure')).toBe(true);
      expect(actor.commands.some(({ id }) => id === 'identify-repair')).toBe(true);
    }
  });

  it('completes the human copy-paste journey inside its independent five-minute budget', async () => {
    const contract = await readContract();
    const actor = contract.actors.find(({ id }) => id === 'human-copy-paste');
    if (actor === undefined) throw new Error('Human acceptance actor is missing.');
    const evidence = await runJourney(actor, contract);
    expect(evidence.gaps, JSON.stringify(evidence)).toEqual([]);
  }, 360_000);

  it('completes the coding-agent journey inside its independent five-minute budget', async () => {
    const contract = await readContract();
    const actor = contract.actors.find(({ id }) => id === 'coding-agent-non-interactive');
    if (actor === undefined) throw new Error('Coding-agent acceptance actor is missing.');
    const evidence = await runJourney(actor, contract);
    expect(evidence.gaps, JSON.stringify(evidence)).toEqual([]);
  }, 360_000);
});
