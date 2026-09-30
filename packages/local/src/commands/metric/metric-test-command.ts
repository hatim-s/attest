import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import { evaluateMetrics, type MetricContext, type MetricEvaluation } from '@attest/runtime';

import { LocalError } from '../../errors/index.js';
import { openAnchored, type AnchoredEntry } from '../../internal/open-anchored.js';
import { isProjectPath } from '../../project/project-path.js';
import type { CommandResult, MetricTestResult } from '../shared/command-result.js';
import { redactProbeValue } from '../agent/adapter/evidence-redaction.js';
import { resolveProcessEnvironment } from '../agent/adapter/resolve-native-agent.js';
import { loadCommandProject } from '../project/load-command-project.js';
import { readMetricTestFixture } from './authoring/index.js';
import { findMetric } from './metric-mutation-command.js';

type MetricReadCommandOptions = {
  metricId?: string;
  project?: string;
  workingDirectory: string;
};

type MetricTestCommandOptions = MetricReadCommandOptions & {
  fixture: string;
  readStdin: () => Promise<string>;
  signal?: AbortSignal;
};

const unsafeMetricDirectory = (path: string, cause?: unknown): LocalError =>
  new LocalError('project_invalid', 'Metric cwd is not a safe project directory.', {
    path,
    hint: 'Use a real project-contained directory without a symlink escape.',
    cause,
  });

/** Opens and identity-checks the executable cwd while retaining a descriptor through invocation. */
const openMetricDirectory = async (
  projectRoot: string,
  configuredPath: string,
): Promise<AnchoredEntry> => {
  const resolvedRoot = await realpath(projectRoot);
  const candidate = resolve(resolvedRoot, configuredPath);
  if (!isProjectPath(resolvedRoot, candidate)) throw unsafeMetricDirectory(configuredPath);
  try {
    return await openAnchored(candidate, { kind: 'directory', root: resolvedRoot });
  } catch (error: unknown) {
    throw unsafeMetricDirectory(configuredPath, error);
  }
};

/** Rechecks the pathname against its retained descriptor immediately before process creation. */
const assertMetricDirectoryIdentity = async (directory: AnchoredEntry): Promise<void> => {
  try {
    const current = await lstat(directory.path, { bigint: true });
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== directory.identity.dev ||
      current.ino !== directory.identity.ino
    ) {
      throw unsafeMetricDirectory(directory.path);
    }
  } catch (error: unknown) {
    if (error instanceof LocalError) throw error;
    throw unsafeMetricDirectory(directory.path);
  }
};

/** Drops the timing so repeated fixture runs produce identical results. */
const withoutDuration = (evaluation: MetricEvaluation): Record<string, unknown> =>
  Object.fromEntries(Object.entries(evaluation).filter(([key]) => key !== 'durationMs'));

/** Tests assertions or trusted argv locally; judge and HTTP definitions remain inspection-only. */
const runMetricTestCommand = async (
  options: MetricTestCommandOptions,
): Promise<CommandResult<'metric-test', MetricTestResult>> => {
  const loaded = await loadCommandProject(options);
  const metric = findMetric(loaded.metrics, options.metricId ?? '');
  const fixture = await readMetricTestFixture(
    options.fixture,
    options.workingDirectory,
    options.readStdin,
  );
  if (metric.definition.kind === 'judge' || metric.definition.kind === 'http') {
    return {
      operation: 'metric-test',
      projectHashBefore: loaded.projectHash,
      projectHashAfter: loaded.projectHash,
      result: {
        metric_id: metric.id,
        kind: metric.definition.kind,
        fixture_valid: true,
        executed: false,
        reason: 'external_execution_not_supported',
      },
    };
  }
  const context: MetricContext = {
    caseDefinition: {
      id: fixture.case.id,
      input: fixture.case.input,
      ...(fixture.case.expected === undefined ? {} : { expected: fixture.case.expected }),
      ...(fixture.case.params === undefined ? {} : { params: fixture.case.params }),
    },
    execution: { outcome: 'completed', output: fixture.output, trace: fixture.trace },
  };
  const definition =
    metric.definition.kind === 'assertion'
      ? { name: metric.id, type: 'assertion' as const, assert: metric.definition.assertions }
      : { name: metric.id, type: 'exec' as const, command: metric.definition.argv };
  let execCwd: string | undefined;
  let execEnv: NodeJS.ProcessEnv | undefined;
  let execDirectory: AnchoredEntry | undefined;
  let secrets: string[] = [];
  if (metric.definition.kind === 'exec') {
    execDirectory = await openMetricDirectory(loaded.root, metric.definition.cwd ?? '.');
    execCwd = execDirectory.path;
    let resolved: Awaited<ReturnType<typeof resolveProcessEnvironment>>;
    try {
      resolved = await resolveProcessEnvironment(metric.definition.env, loaded.root);
    } catch (error: unknown) {
      throw new LocalError(
        'metric_infrastructure_failed',
        'A referenced metric secret is unavailable.',
        {
          hint: 'Set the referenced secret and retry the local metric test.',
          cause: error,
        },
      );
    }
    execEnv = resolved.env;
    secrets = resolved.secrets;
  }
  let evaluation: MetricEvaluation | undefined;
  try {
    if (execDirectory !== undefined) {
      await assertMetricDirectoryIdentity(execDirectory);
    }
    [evaluation] = await evaluateMetrics([definition], context, {
      execCwd,
      execEnv,
      execTimeoutMs: metric.definition.kind === 'exec' ? metric.definition.timeout_ms : undefined,
      signal: options.signal,
    });
  } finally {
    await execDirectory?.handle.close().catch(() => undefined);
  }
  if (evaluation === undefined) {
    throw new LocalError('metric_infrastructure_failed', 'Metric test produced no evaluation.');
  }
  const redacted = redactProbeValue(withoutDuration(evaluation), secrets);
  if (evaluation.status === 'error') {
    throw new LocalError('metric_infrastructure_failed', 'Metric fixture execution failed.', {
      path: metric.id,
      hint: 'Inspect the redacted local evaluation details and repair the executable fixture.',
      details: { evaluation: redacted },
    });
  }
  const passed = evaluation.status === 'evaluated' ? evaluation.result.pass : false;
  if (passed !== fixture.expected_pass) {
    throw new LocalError('metric_fixture_mismatch', 'Metric result did not match the fixture.', {
      path: metric.id,
      hint: 'Inspect the deterministic evaluation and repair the metric or expected_pass value.',
      details: {
        actual_pass: passed,
        expected_pass: fixture.expected_pass,
        evaluation: redacted,
      },
    });
  }
  return {
    operation: 'metric-test',
    projectHashBefore: loaded.projectHash,
    projectHashAfter: loaded.projectHash,
    result: {
      metric_id: metric.id,
      kind: metric.definition.kind,
      fixture_valid: true,
      executed: true,
      expected_pass: fixture.expected_pass,
      evaluation: redacted,
    },
  };
};

export { runMetricTestCommand, type MetricTestCommandOptions };
