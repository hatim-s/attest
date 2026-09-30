import { isAbsolute, resolve } from 'node:path';

import type { EvalRun } from '@attest/contracts';

import { LocalError } from '../../errors/index.js';
import { isProjectPath, resolveContainedPath } from '../../project/project-path.js';
import { createBaseEnvironment } from '../agent/native-agent-adapter/index.js';
import {
  HookCommandError,
  runHookCommand,
  type HookCommand,
  type HookPhase,
} from './hook-command.js';

const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

type LifecycleConfig = {
  hooks?: Partial<Record<HookPhase, HookCommand>>;
  workers?: { count: number; directory: string };
};

type CaseHookContext = { case_id: string; test_id: string; worker_index: number };

/** Anchors explicitly relative hook paths to the project snapshot before worker cwd changes. */
const resolveHookArgv = (projectRoot: string, argv: readonly string[]): string[] =>
  argv.map((argument) => {
    if (!argument.startsWith('./') && !argument.startsWith('../')) return argument;
    const resolved = resolve(projectRoot, argument);
    if (!isProjectPath(projectRoot, resolved)) {
      throw new LocalError('project_invalid', 'Eval hook argument path escapes the project.', {
        path: argument,
      });
    }
    return resolved;
  });

/** Resolves a snapshotted worker template and rejects substitutions that escape the project. */
const resolveWorkerDirectory = (
  projectRoot: string,
  runId: string,
  workerIndex: number,
  config: LifecycleConfig | undefined,
): string | undefined => {
  const template = config?.workers?.directory;
  if (template === undefined) return undefined;
  const workers = config?.workers;
  if (workers !== undefined && workers.count > 1 && !template.includes('{worker_index}')) {
    throw new LocalError(
      'project_invalid',
      'Eval worker directory must include {worker_index} when worker count exceeds one.',
      { path: template },
    );
  }
  const relative = template
    .replaceAll('{run_id}', runId)
    .replaceAll('{worker_index}', String(workerIndex));
  const directory = resolve(projectRoot, relative);
  if (directory === resolve(projectRoot) || !isProjectPath(projectRoot, directory)) {
    throw new LocalError(
      'project_invalid',
      `Eval worker directory escapes the project: ${relative}`,
      {
        path: relative,
      },
    );
  }
  return directory;
};

/** Creates a worker directory whose every segment is a real directory inside the project. */
const prepareWorkerDirectory = async (projectRoot: string, directory: string): Promise<string> =>
  resolveContainedPath(projectRoot, directory, {
    allowAbsolute: true,
    createDirectories: true,
    expect: 'directory',
    problem: () =>
      new LocalError(
        'project_invalid',
        'Eval worker directory escapes the project through a symbolic link.',
        { path: directory },
      ),
  });

type RunHookOptions = {
  command: HookCommand | undefined;
  cwd: string;
  environment: Record<string, string>;
  phase: HookPhase;
  signal?: AbortSignal;
};

type CasePhase = Extract<
  HookPhase,
  'after_agent' | 'after_case' | 'after_evaluation' | 'before_case'
>;

type CasePhaseRequest = {
  context: CaseHookContext;
  /** Prepared worker directory; hooks run in the project root when workers are not configured. */
  directory: string | undefined;
  /** Case outcome exposed to after-phase hooks as ATTEST_CASE_OUTCOME. */
  outcome?: string;
  signal?: AbortSignal;
};

/** Owns project-authored run/case hooks and stable worker directories for one immutable run. */
const createEvalLifecycle = (projectRoot: string, run: EvalRun) => {
  const config = run.effective_command.resolved.execution;
  const runEnvironment = { ATTEST_PROJECT_ROOT: projectRoot, ATTEST_RUN_ID: run.run_id };
  let cleanupConfirmed = true;

  /** Runs one argv-only hook with an isolated environment and bounded process cleanup. */
  const runHook = async (options: RunHookOptions): Promise<void> => {
    if (options.command === undefined) return;
    const [file, ...argumentsList] = resolveHookArgv(projectRoot, options.command.argv);
    const executable =
      file !== undefined && !isAbsolute(file) && file.includes('/')
        ? resolve(projectRoot, file)
        : file;
    try {
      await runHookCommand({
        command: {
          ...options.command,
          argv: executable === undefined ? [] : [executable, ...argumentsList],
        },
        cwd: options.cwd,
        env: { ...createBaseEnvironment(), ...options.environment },
        phase: options.phase,
        timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
        signal: options.signal,
      });
    } catch (error: unknown) {
      // Retain cleanup uncertainty until the runner releases cancellation ownership.
      if (error instanceof HookCommandError && !error.cleanupConfirmed) cleanupConfirmed = false;
      throw error;
    }
  };

  /** Runs one case-scoped hook in the worker directory with the case identity in its env. */
  const runCasePhase = (phase: CasePhase, request: CasePhaseRequest): Promise<void> =>
    runHook({
      command: config?.hooks?.[phase],
      cwd: request.directory ?? projectRoot,
      environment: {
        ...runEnvironment,
        ATTEST_CASE_ID: request.context.case_id,
        ATTEST_TEST_ID: request.context.test_id,
        ATTEST_WORKER_INDEX: String(request.context.worker_index),
        ...(request.directory === undefined ? {} : { ATTEST_WORKER_DIRECTORY: request.directory }),
        ...(request.outcome === undefined ? {} : { ATTEST_CASE_OUTCOME: request.outcome }),
      },
      phase,
      signal: request.signal,
    });

  const prepareCase = async (context: CaseHookContext): Promise<string | undefined> => {
    const configuredDirectory = resolveWorkerDirectory(
      projectRoot,
      run.run_id,
      context.worker_index,
      config,
    );
    if (configuredDirectory === undefined) return undefined;
    return prepareWorkerDirectory(projectRoot, configuredDirectory);
  };

  return {
    afterRun: (status: string, summary: unknown): Promise<void> =>
      runHook({
        command: config?.hooks?.after_run,
        cwd: projectRoot,
        environment: {
          ...runEnvironment,
          ATTEST_RUN_STATUS: status,
          ATTEST_RUN_SUMMARY: JSON.stringify(summary),
        },
        phase: 'after_run',
      }),
    assertCleanup: (): void => {
      if (!cleanupConfirmed) {
        throw new HookCommandError('Eval hook process cleanup could not be confirmed.', false);
      }
    },
    beforeRun: (signal: AbortSignal): Promise<void> =>
      runHook({
        command: config?.hooks?.before_run,
        cwd: projectRoot,
        environment: runEnvironment,
        phase: 'before_run',
        signal,
      }),
    prepareCase,
    runCasePhase,
  };
};

export { createEvalLifecycle, prepareWorkerDirectory, resolveHookArgv, resolveWorkerDirectory };
