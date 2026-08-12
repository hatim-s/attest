import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  type CommandRequest,
  type JsonValue,
  type MetricResource,
  type ProjectResources,
  type SecretReference,
} from '@attest/contracts';
import { evaluateMetrics, type MetricContext, type MetricEvaluation } from '@attest/core';

import { AttestCliError } from '../../errors/index.js';
import { loadProject, type LoadedProject } from '../../project/load-project.js';
import { isProjectPath } from '../../project/project-path.js';
import {
  type PublishObserver,
  type SemanticProjectOperation,
} from '../../project/transaction/index.js';
import type { CommandResult } from '../shared/command-result.js';
import { executeProjectMutation } from '../shared/project-mutation.js';
import {
  createBaseEnvironment,
  readSecretReference,
  redactProbeValue,
} from '../agent/native-agent-adapter.js';
import { loadCommandProject } from '../project/load-command-project.js';
import { redactMetricResource } from '../show/redact-resource.js';
import {
  assertSafeMetricResource,
  readImportedMetricResource,
  readMetricTestFixture,
  type Prompt,
} from './metric-command-input.js';

type MetricAuthoringRequest = Extract<
  CommandRequest,
  { command: 'metric.add' | 'metric.import' | 'metric.remove' | 'metric.rename' }
>;

type MetricMutationCommandOptions = {
  interactive: boolean;
  project?: string;
  prompt?: Prompt;
  publishObserver?: PublishObserver;
  readStdin: () => Promise<string>;
  request: MetricAuthoringRequest;
  workingDirectory: string;
};

type MetricReadCommandOptions = {
  metricId?: string;
  project?: string;
  workingDirectory: string;
};

type MetricTestCommandOptions = MetricReadCommandOptions & {
  cwdObserver?: (path: string) => Promise<void>;
  fixture: string;
  readStdin: () => Promise<string>;
  signal?: AbortSignal;
};

type MutationBuildResult = {
  candidate: ProjectResources;
  metric: MetricResource;
  renames?: readonly { from: string; to: string; type: 'metric' }[];
  warnings?: string[];
};

const candidateFromLoadedProject = (loaded: LoadedProject): ProjectResources =>
  structuredClone({
    agents: loaded.agents,
    datasets: loaded.datasets,
    metrics: loaded.metrics,
    project: loaded.project,
    tests: loaded.tests,
  });

const findMetric = (metrics: readonly MetricResource[], id: string): MetricResource => {
  const metric = metrics.find((candidate) => candidate.id === id);
  if (metric === undefined) {
    throw new AttestCliError('resource_not_found', `Metric ${id} was not found.`, {
      path: id,
      hint: 'Run `attest list metrics` to inspect available metric ids.',
    });
  }
  return metric;
};

const assertNewMetricId = (metrics: readonly MetricResource[], id: string): void => {
  if (metrics.some((metric) => metric.id === id)) {
    throw new AttestCliError('project_invalid', `Metric ${id} already exists.`, {
      path: id,
      hint: 'Choose a new metric id or rename the existing resource.',
    });
  }
};

/** Lists every authored location that would become dangling if a metric disappeared. */
const metricReferencePaths = (project: ProjectResources, metricId: string): string[] => {
  const paths: string[] = [];
  for (const test of project.tests) {
    test.metrics.forEach(({ metric_id: id }, index) => {
      if (id === metricId) paths.push(`/tests/${test.id}/metrics/${index}`);
    });
    test.cases.forEach((testCase, caseIndex) =>
      testCase.metric_overrides?.forEach(({ metric_id: id }, overrideIndex) => {
        if (id === metricId) {
          paths.push(`/tests/${test.id}/cases/${caseIndex}/metric_overrides/${overrideIndex}`);
        }
      }),
    );
  }
  for (const dataset of project.datasets) {
    dataset.cases.forEach((testCase, caseIndex) =>
      testCase.metric_overrides?.forEach(({ metric_id: id }, overrideIndex) => {
        if (id === metricId) {
          paths.push(
            `/datasets/${dataset.metadata.id}/cases/${caseIndex}/metric_overrides/${overrideIndex}`,
          );
        }
      }),
    );
  }
  return paths.sort();
};

/** Rewrites every direct, attached, and dataset-case metric reference in one candidate snapshot. */
const rewriteMetricReferences = (
  project: ProjectResources,
  from: string,
  to: string | undefined,
): void => {
  for (const test of project.tests) {
    test.metrics =
      to === undefined
        ? test.metrics.filter(({ metric_id: id }) => id !== from)
        : test.metrics.map((reference) =>
            reference.metric_id === from ? { ...reference, metric_id: to } : reference,
          );
    test.cases.forEach((testCase) => {
      if (testCase.metric_overrides === undefined) return;
      testCase.metric_overrides =
        to === undefined
          ? testCase.metric_overrides.filter(({ metric_id: id }) => id !== from)
          : testCase.metric_overrides.map((override) =>
              override.metric_id === from ? { ...override, metric_id: to } : override,
            );
    });
  }
  project.datasets.forEach((dataset) =>
    dataset.cases.forEach((testCase) => {
      if (testCase.metric_overrides === undefined) return;
      testCase.metric_overrides =
        to === undefined
          ? testCase.metric_overrides.filter(({ metric_id: id }) => id !== from)
          : testCase.metric_overrides.map((override) =>
              override.metric_id === from ? { ...override, metric_id: to } : override,
            );
    }),
  );
};

/** Builds and cross-validates the complete project candidate before transactional publication. */
const buildMetricMutation = async (
  loaded: LoadedProject,
  request: MetricAuthoringRequest,
  options: MetricMutationCommandOptions,
): Promise<MutationBuildResult> => {
  const candidate = candidateFromLoadedProject(loaded);
  switch (request.command) {
    case 'metric.add':
      assertSafeMetricResource(request.metric);
      assertNewMetricId(candidate.metrics, request.metric.id);
      candidate.metrics.push(request.metric);
      return { candidate, metric: request.metric };
    case 'metric.import': {
      assertNewMetricId(candidate.metrics, request.as);
      const metric = await readImportedMetricResource(
        request.source,
        request.as,
        request.name,
        options.workingDirectory,
        options.readStdin,
      );
      candidate.metrics.push(metric);
      return { candidate, metric };
    }
    case 'metric.rename': {
      const metric = findMetric(candidate.metrics, request.metric_id);
      assertNewMetricId(candidate.metrics, request.new_id);
      metric.id = request.new_id;
      rewriteMetricReferences(candidate, request.metric_id, request.new_id);
      return {
        candidate,
        metric,
        renames: [{ from: request.metric_id, to: request.new_id, type: 'metric' }],
      };
    }
    case 'metric.remove': {
      const metric = findMetric(candidate.metrics, request.metric_id);
      const references = metricReferencePaths(candidate, request.metric_id);
      if (references.length > 0 && request.detach !== true) {
        throw new AttestCliError('project_invalid', 'Referenced metrics cannot be removed.', {
          path: request.metric_id,
          hint: 'Detach the metric from every test and case, or pass `--detach` explicitly.',
          details: { reference_paths: references },
        });
      }
      candidate.metrics = candidate.metrics.filter(({ id }) => id !== request.metric_id);
      if (request.detach === true) rewriteMetricReferences(candidate, request.metric_id, undefined);
      return {
        candidate,
        metric,
        ...(references.length === 0
          ? {}
          : { warnings: [`Detached ${references.length} metric references before removal.`] }),
      };
    }
  }
};

const renderOperations = (operations: readonly SemanticProjectOperation[]): string =>
  operations
    .map((operation) => {
      const previous = operation.previous_id === undefined ? '' : ` from ${operation.previous_id}`;
      return `  ${operation.op} ${operation.resource.type} ${operation.resource.id}${previous}`;
    })
    .join('\n');

/** Applies the shared preview-confirm-publish pipeline with the observed hash as commit guard. */
const runMetricMutationCommand = async (
  options: MetricMutationCommandOptions,
): Promise<CommandResult> => {
  // Dry-run must not acquire a write-capable reader lock or recover transaction journals.
  const loaded =
    options.request.dry_run === true
      ? await loadProject({ project: options.project, workingDirectory: options.workingDirectory })
      : await loadCommandProject({
          project: options.project,
          workingDirectory: options.workingDirectory,
        });
  const built = await buildMetricMutation(loaded, options.request, options);
  const mutationOptions = {
    candidate: built.candidate,
    expectedProjectHash: options.request.if_project_hash ?? loaded.projectHash,
    projectRoot: loaded.root,
    renames: built.renames,
    warnings: built.warnings,
  };
  const destructive = options.request.command === 'metric.remove';
  const mutation = await executeProjectMutation({
    dryRun: options.request.dry_run === true,
    mutation: mutationOptions,
    publishObserver: options.publishObserver,
    confirm: async (preview) => {
      if (options.request.yes === true) return;
      if (options.interactive && options.prompt !== undefined) {
        const resourcePreview = destructive
          ? `Remove metric ${built.metric.id}`
          : JSON.stringify(redactMetricResource(built.metric), undefined, 2);
        const answer = (
          await options.prompt(
            `${resourcePreview}\nSemantic diff:\n${renderOperations(preview.diff.operations)}\nApply these changes? [y/N]: `,
          )
        )
          .trim()
          .toLowerCase();
        if (answer !== 'y' && answer !== 'yes') {
          throw new AttestCliError('cancelled', 'Metric mutation was not confirmed.');
        }
      } else if (destructive) {
        throw new AttestCliError('cli_missing_input', 'Metric removal requires confirmation.', {
          path: '--yes',
          hint: 'Pass --yes, set `yes: true`, or preview with --dry-run.',
        });
      }
    },
  });
  const dryRun = options.request.dry_run === true;
  return {
    human: [
      `${dryRun ? 'Dry run: would update' : 'Updated'} metric ${built.metric.id}.`,
      ...(dryRun
        ? [
            'Semantic diff:',
            renderOperations(mutation.diff.operations),
            'Next: remove `--dry-run` to apply these changes.',
          ]
        : []),
      `Project hash: ${mutation.projectHashAfter}`,
    ].join('\n'),
    projectHashBefore: mutation.projectHashBefore,
    projectHashAfter: mutation.projectHashAfter,
    result: {
      committed: mutation.committed,
      dry_run: dryRun,
      resource: { id: built.metric.id, type: 'metric' },
      operations: mutation.diff.operations as unknown as JsonValue,
    },
    warnings: built.warnings?.map((message) => ({ code: 'metric_references_detached', message })),
  };
};

type AnchoredMetricDirectory = {
  handle: FileHandle;
  identity: BigIntStats;
  path: string;
};

const unsafeMetricDirectory = (path: string): AttestCliError =>
  new AttestCliError('project_invalid', 'Metric cwd is not a safe project directory.', {
    path,
    hint: 'Use a real project-contained directory without a symlink escape.',
  });

/** Opens and identity-checks the executable cwd while retaining a descriptor through invocation. */
const openMetricDirectory = async (
  projectRoot: string,
  configuredPath: string,
): Promise<AnchoredMetricDirectory> => {
  const resolvedRoot = await realpath(projectRoot);
  const candidate = resolve(resolvedRoot, configuredPath);
  if (!isProjectPath(resolvedRoot, candidate)) throw unsafeMetricDirectory(configuredPath);
  let handle: FileHandle | undefined;
  try {
    handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const [identity, pathIdentity, resolvedPath] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(candidate, { bigint: true }),
      realpath(candidate),
    ]);
    if (
      !identity.isDirectory() ||
      pathIdentity.isSymbolicLink() ||
      identity.dev !== pathIdentity.dev ||
      identity.ino !== pathIdentity.ino ||
      !isProjectPath(resolvedRoot, resolvedPath)
    ) {
      throw unsafeMetricDirectory(configuredPath);
    }
    return { handle, identity, path: resolvedPath };
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined);
    if (error instanceof AttestCliError) throw error;
    throw unsafeMetricDirectory(configuredPath);
  }
};

/** Rechecks the pathname against its retained descriptor immediately before process creation. */
const assertMetricDirectoryIdentity = async (directory: AnchoredMetricDirectory): Promise<void> => {
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
    if (error instanceof AttestCliError) throw error;
    throw unsafeMetricDirectory(directory.path);
  }
};

/** Resolves exec-only environment references immediately before starting the trusted fixture. */
const resolveMetricEnvironment = async (
  env: Readonly<Record<string, SecretReference>> | undefined,
  projectRoot: string,
): Promise<{ environment: NodeJS.ProcessEnv; secrets: string[] }> => {
  const environment: NodeJS.ProcessEnv = createBaseEnvironment();
  const secrets: string[] = [];
  for (const [target, reference] of Object.entries(env ?? {})) {
    let value: string;
    try {
      value = await readSecretReference(reference, projectRoot);
    } catch (error: unknown) {
      throw new AttestCliError(
        'metric_infrastructure_failed',
        'A referenced metric secret is unavailable.',
        {
          path: target,
          hint: 'Set the referenced secret and retry the local metric test.',
          cause: error,
        },
      );
    }
    environment[target] = value;
    secrets.push(value);
  }
  return { environment, secrets };
};

const withoutDuration = (evaluation: MetricEvaluation): JsonValue => {
  const deterministic = structuredClone(evaluation);
  Reflect.deleteProperty(deterministic, 'durationMs');
  return deterministic;
};

/** Tests assertions or trusted argv locally; judge and HTTP definitions remain inspection-only. */
const runMetricTestCommand = async (options: MetricTestCommandOptions): Promise<CommandResult> => {
  const loaded = await loadCommandProject(options);
  const metric = findMetric(loaded.metrics, options.metricId ?? '');
  const fixture = await readMetricTestFixture(
    options.fixture,
    options.workingDirectory,
    options.readStdin,
  );
  if (metric.definition.kind === 'judge' || metric.definition.kind === 'http') {
    return {
      human: `Metric ${metric.id} fixture is valid; ${metric.definition.kind} execution was not started.`,
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
  let execDirectory: AnchoredMetricDirectory | undefined;
  let secrets: string[] = [];
  if (metric.definition.kind === 'exec') {
    execDirectory = await openMetricDirectory(loaded.root, metric.definition.cwd ?? '.');
    execCwd = execDirectory.path;
    const resolved = await resolveMetricEnvironment(metric.definition.env, loaded.root);
    execEnv = resolved.environment;
    secrets = resolved.secrets;
  }
  let evaluation: MetricEvaluation | undefined;
  try {
    if (execDirectory !== undefined) {
      await options.cwdObserver?.(execDirectory.path);
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
    throw new AttestCliError('metric_infrastructure_failed', 'Metric test produced no evaluation.');
  }
  const redacted = redactProbeValue(withoutDuration(evaluation), secrets);
  if (evaluation.status === 'error') {
    throw new AttestCliError('metric_infrastructure_failed', 'Metric fixture execution failed.', {
      path: metric.id,
      hint: 'Inspect the redacted local evaluation details and repair the executable fixture.',
      details: { evaluation: redacted },
    });
  }
  const passed = evaluation.status === 'evaluated' ? evaluation.result.pass : false;
  if (passed !== fixture.expected_pass) {
    throw new AttestCliError(
      'metric_fixture_mismatch',
      'Metric result did not match the fixture.',
      {
        path: metric.id,
        hint: 'Inspect the deterministic evaluation and repair the metric or expected_pass value.',
        details: {
          actual_pass: passed,
          expected_pass: fixture.expected_pass,
          evaluation: redacted,
        },
      },
    );
  }
  return {
    human: `Metric ${metric.id} matched expected_pass=${fixture.expected_pass}.`,
    projectHashBefore: loaded.projectHash,
    projectHashAfter: loaded.projectHash,
    result: {
      metric_id: metric.id,
      kind: metric.definition.kind,
      fixture_valid: true,
      executed: true,
      evaluation: redacted,
    },
  };
};

export {
  metricReferencePaths,
  rewriteMetricReferences,
  runMetricMutationCommand,
  runMetricTestCommand,
  type MetricAuthoringRequest,
  type MetricMutationCommandOptions,
  type MetricReadCommandOptions,
  type MetricTestCommandOptions,
};
