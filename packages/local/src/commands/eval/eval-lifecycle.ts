import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import type { EvalRun } from '@attest/contracts';

import { LocalError } from '../../errors/index.js';
import { isProjectPath } from '../../project/project-path.js';
import { createBaseEnvironment } from '../agent/native-agent-adapter/index.js';
import {
  HookCommandError,
  runHookCommand,
  type HookCommand,
  type HookPhase,
} from './hook-command.js';

const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

type LifecycleConfig = {
  hooks?: Partial<Record<'before_run' | 'before_case' | 'after_case' | 'after_run', HookCommand>>;
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

/** Creates a worker directory only after its nearest existing target resolves inside the project. */
const prepareWorkerDirectory = async (projectRoot: string, directory: string): Promise<string> => {
  const resolvedRoot = await realpath(projectRoot);
  let ancestor = directory;
  while (true) {
    try {
      ancestor = await realpath(ancestor);
      break;
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      const parent = resolve(ancestor, '..');
      if (parent === ancestor) {
        throw new LocalError('run_failed', 'Eval worker directory has no existing ancestor.', {
          path: directory,
        });
      }
      ancestor = parent;
    }
  }
  if (!isProjectPath(resolvedRoot, ancestor)) {
    throw new LocalError(
      'project_invalid',
      'Eval worker directory escapes the project through a symbolic link.',
      { path: directory },
    );
  }
  await mkdir(directory, { recursive: true });
  const resolvedDirectory = await realpath(directory);
  if (resolvedDirectory === resolvedRoot || !isProjectPath(resolvedRoot, resolvedDirectory)) {
    throw new LocalError(
      'project_invalid',
      'Eval worker directory escapes the project through a symbolic link.',
      { path: directory },
    );
  }
  return resolvedDirectory;
};

/** Runs one argv-only lifecycle hook with isolated environment and bounded process cleanup. */
const runHook = async (
  command: HookCommand | undefined,
  cwd: string,
  environment: Record<string, string>,
  phase: HookPhase,
  projectRoot: string,
  signal?: AbortSignal,
): Promise<void> => {
  if (command === undefined) return;
  const [file, ...argumentsList] = resolveHookArgv(projectRoot, command.argv);
  const executable =
    file !== undefined && !isAbsolute(file) && file.includes('/')
      ? resolve(projectRoot, file)
      : file;
  await runHookCommand({
    command: { ...command, argv: executable === undefined ? [] : [executable, ...argumentsList] },
    cwd,
    env: { ...createBaseEnvironment(), ...environment },
    phase,
    timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
    signal,
  });
};

/** Owns project-authored run/case hooks and stable worker directories for one immutable run. */
const createEvalLifecycle = (projectRoot: string, run: EvalRun) => {
  const config = run.effective_command.resolved.execution;
  const runEnvironment = { ATTEST_PROJECT_ROOT: projectRoot, ATTEST_RUN_ID: run.run_id };
  let cleanupConfirmed = true;

  /** Retains cleanup uncertainty until the runner releases cancellation ownership. */
  const trackedRunHook = async (...arguments_: Parameters<typeof runHook>): Promise<void> => {
    try {
      await runHook(...arguments_);
    } catch (error: unknown) {
      if (error instanceof HookCommandError && !error.cleanupConfirmed) cleanupConfirmed = false;
      throw error;
    }
  };

  const caseEnvironment = (context: CaseHookContext, workerDirectory?: string) => ({
    ...runEnvironment,
    ATTEST_CASE_ID: context.case_id,
    ATTEST_TEST_ID: context.test_id,
    ATTEST_WORKER_INDEX: String(context.worker_index),
    ...(workerDirectory === undefined ? {} : { ATTEST_WORKER_DIRECTORY: workerDirectory }),
  });

  const prepareCase = async (context: CaseHookContext) => {
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
    afterCase: async (
      context: CaseHookContext,
      workerDirectory: string | undefined,
      outcome: string,
    ): Promise<void> => {
      const cwd = workerDirectory ?? projectRoot;
      return trackedRunHook(
        config?.hooks?.after_case,
        cwd,
        { ...caseEnvironment(context, workerDirectory), ATTEST_CASE_OUTCOME: outcome },
        'after_case',
        projectRoot,
      );
    },
    afterRun: async (status: string, summary: unknown): Promise<void> =>
      trackedRunHook(
        config?.hooks?.after_run,
        projectRoot,
        {
          ...runEnvironment,
          ATTEST_RUN_STATUS: status,
          ATTEST_RUN_SUMMARY: JSON.stringify(summary),
        },
        'after_run',
        projectRoot,
      ),
    beforeCase: async (
      context: CaseHookContext,
      workerDirectory: string | undefined,
      signal: AbortSignal,
    ): Promise<void> => {
      const cwd = workerDirectory ?? projectRoot;
      return trackedRunHook(
        config?.hooks?.before_case,
        cwd,
        caseEnvironment(context, workerDirectory),
        'before_case',
        projectRoot,
        signal,
      );
    },
    beforeRun: async (signal: AbortSignal): Promise<void> =>
      trackedRunHook(
        config?.hooks?.before_run,
        projectRoot,
        runEnvironment,
        'before_run',
        projectRoot,
        signal,
      ),
    assertCleanup: (): void => {
      if (!cleanupConfirmed) {
        throw new HookCommandError('Eval hook process cleanup could not be confirmed.', false);
      }
    },
    prepareCase,
  };
};

export { createEvalLifecycle, prepareWorkerDirectory, resolveHookArgv, resolveWorkerDirectory };
