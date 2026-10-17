import { spawn } from 'node:child_process';
import { access, cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cliErrorCatalogSchema,
  cliHelpSchema,
  cliResultSchema,
  evalEventSchema,
  evalEventStreamSchema,
  type CliResult,
} from '@attest/contracts';
import { describe, expect, inject, it, onTestFinished } from 'vitest';

import { runPackedCommand, type PackedCommandResult } from './packed-cli.js';
import {
  quickstartJourneys,
  type CommandExpectation,
  type Journeys,
} from './fixtures/quickstart-journeys.js';
import { snapshotTree, type TreeSnapshot } from './snapshot-tree.js';

type CommandResult = PackedCommandResult & {
  readiness?: { body: string; status: number; url: string };
};

const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures/quickstart', import.meta.url));

const RUN_ID_PATTERN = /\b[0-9A-HJKMNP-TV-Z]{26}\b/u;

/** Starts `attest view`, fetches the dashboard once it is ready, then stops it with SIGINT. */
const runViewReadinessProbe = async (
  cliPath: string,
  argv: readonly string[],
  workingDirectory: string,
  timeout: number,
): Promise<CommandResult> => {
  const child = spawn(process.execPath, ['--no-warnings', cliPath, ...argv], {
    cwd: workingDirectory,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const deadline = AbortSignal.timeout(timeout);
  let stdout = '';
  let stderr = '';
  let ready = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));

  const readinessUrl = await new Promise<string>((resolveReadiness, rejectReadiness) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectReadiness(new Error(`View readiness exceeded ${String(timeout)}ms.`));
    }, timeout);

    child.once('error', (error) => {
      clearTimeout(timer);
      rejectReadiness(error);
    });
    child.once('exit', (code, signal) => {
      if (ready) return;
      clearTimeout(timer);
      rejectReadiness(new Error(`View exited before readiness with ${String(code ?? signal)}.`));
    });
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const match = /Attest view: (http:\/\/127\.0\.0\.1:\d+\/)/u.exec(stdout);

      if (match?.[1] === undefined || ready) return;
      ready = true;
      clearTimeout(timer);
      resolveReadiness(match[1]);
    });
  });

  try {
    const response = await fetch(readinessUrl, { signal: deadline });
    const readiness = { body: await response.text(), status: response.status, url: readinessUrl };

    return { exitCode: 0, readiness, stderr, stdout };
  } finally {
    child.kill('SIGINT');
    const forceStop = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await exited;
    clearTimeout(forceStop);
  }
};

/** The result document a command printed, and the run id it reported, if any. */
type PrintedResult = { document?: CliResult; runId?: string };

/** Reads JSON, the JSONL `result` and `run_started` events, or the run id in human text. */
const readPrintedResult = (expectation: CommandExpectation, stdout: string): PrintedResult => {
  if (expectation.output === 'json') return { document: cliResultSchema.parse(JSON.parse(stdout)) };

  if (expectation.output === 'human') return { runId: RUN_ID_PATTERN.exec(stdout)?.[0] };

  const events = evalEventStreamSchema.parse(
    stdout
      .trim()
      .split('\n')
      .map((line) => evalEventSchema.parse(JSON.parse(line))),
  );

  const [started] = events;
  const terminal = events.at(-1);

  if (terminal?.event !== 'result') throw new Error('Eval JSONL stream omitted its result.');
  expect(terminal.data.exit_code, expectation.id).toBe(expectation.exit_code);

  return {
    document: terminal.data.result,
    runId: started?.event === 'run_started' ? started.data.run_id : undefined,
  };
};

const materialize = (value: string, runId: string | undefined): string => {
  if (!value.includes('$RUN_ID')) return value;

  if (runId === undefined) throw new Error('A command referenced $RUN_ID before eval completion.');

  return value.replaceAll('$RUN_ID', runId);
};

/** Checks one command's result document, printed text, and files; returns the run id so far. */
const assertCommand = async (
  expectation: CommandExpectation,
  result: CommandResult,
  root: string,
  before: TreeSnapshot,
  priorRunId: string | undefined,
): Promise<string | undefined> => {
  const label = expectation.id;
  expect(result.exitCode, `${label}: ${result.stderr || result.stdout}`).toBe(
    expectation.exit_code,
  );
  expect(result.stderr, label).toBe('');

  const { document, runId: printedRunId } = readPrintedResult(expectation, result.stdout);

  if (document !== undefined) {
    expect(document.ok, label).toBe(expectation.error_code === undefined);

    if (expectation.command !== undefined)
      expect(document.command, label).toBe(expectation.command);

    if (document.ok) {
      if (expectation.result_schema === 'run') {
        expect(document.result, label).toMatchObject({ resource_type: 'run' });
      } else if (expectation.result_schema !== undefined) {
        expect(document.result, label).toMatchObject({ schema: expectation.result_schema });
      }

      if (expectation.catalog_error_code !== undefined) {
        const catalog = cliErrorCatalogSchema.parse(document.result);
        const entry = catalog.errors.find(({ code }) => code === expectation.catalog_error_code);
        expect(entry?.repairs.length, label).toBeGreaterThan(0);
      }

      if (expectation.help_usage !== undefined) {
        const { command } = cliHelpSchema.parse(document.result);
        expect(command.usage, label).toBe(expectation.help_usage);
        expect(
          command.arguments.map(({ name }) => name),
          label,
        ).toEqual(expectation.help_arguments);
      }
    } else {
      if (expectation.error_code !== undefined) {
        expect(document.error.code, label).toBe(expectation.error_code);
      }

      for (const field of expectation.required_error_fields ?? []) {
        expect(document.error, `${label}: error.${field}`).toHaveProperty(field);
      }
    }
  }

  let runId = priorRunId;

  if (expectation.capture_run_id === true) {
    expect(printedRunId, label).toMatch(RUN_ID_PATTERN);
    runId = printedRunId;
  }

  for (const required of expectation.required_stdout ?? []) {
    expect(result.stdout, `${label}: ${required}`).toContain(materialize(required, runId));
  }

  if (expectation.readiness_probe === 'view') {
    expect(result.readiness?.url, label).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);
    expect(result.readiness?.status, label).toBe(200);
    expect(result.readiness?.body, label).toContain('<!doctype html>');
  }

  if (expectation.no_write === true) expect(await snapshotTree(root), label).toEqual(before);

  for (const path of expectation.artifacts_present ?? []) {
    const artifact = join(root, materialize(path, runId));
    await expect(access(artifact), `${label}: ${artifact}`).resolves.toBeUndefined();

    if (artifact.endsWith('.html')) {
      const report = await readFile(artifact, 'utf8');
      expect(report, label).toContain('<!doctype html>');
      expect(report, label).toContain(runId);
    }
  }

  for (const path of expectation.artifacts_absent ?? []) {
    const artifact = join(root, materialize(path, runId));
    await expect(access(artifact), `${label}: ${artifact}`).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }

  return runId;
};

/** Runs one actor's commands in a fresh copy of the quickstart fixture. */
const runJourney = async (actorId: string): Promise<void> => {
  const { cliPath } = inject('packedCli');
  const journeys: Journeys = quickstartJourneys;
  const actor = journeys.actors.find(({ id }) => id === actorId);

  if (actor === undefined) throw new Error(`Acceptance actor ${actorId} is missing.`);
  const root = await mkdtemp(join(tmpdir(), `attest-quickstart-${actor.id}-`));
  onTestFinished(() => rm(root, { force: true, recursive: true }));
  await cp(FIXTURE_ROOT, root, { recursive: true });
  const fixtureSnapshot = await snapshotTree(root);
  expect([...fixtureSnapshot.keys()].sort()).toEqual([...journeys.fixture_files].sort());

  let runId: string | undefined;

  for (const command of actor.commands) {
    const argv = command.argv.map((argument) => materialize(argument, runId));
    const before = await snapshotTree(root);
    const timeout = journeys.per_command_timeout_ms;

    const result =
      command.readiness_probe === 'view'
        ? await runViewReadinessProbe(cliPath, argv, root, timeout)
        : await runPackedCommand(cliPath, argv, root, timeout);

    runId = await assertCommand(command, result, root, before, runId);
  }

  // The fixture files stand for the user's own assets; the CLI must never rewrite them.
  const finalSnapshot = await snapshotTree(root);

  for (const [path, hash] of fixtureSnapshot) expect(finalSnapshot.get(path), path).toBe(hash);
  expect([...finalSnapshot.keys()].some((path) => /\.ya?ml$/u.test(path))).toBe(false);
};

describe('quickstart journeys through the packed CLI', () => {
  it('completes the human copy-paste journey', () => runJourney('human-copy-paste'), 360_000);

  it(
    'completes the coding-agent journey',
    () => runJourney('coding-agent-non-interactive'),
    360_000,
  );
});
