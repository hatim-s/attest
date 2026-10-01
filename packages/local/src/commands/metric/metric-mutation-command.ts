import type { CommandRequest, MetricResource, ProjectResources } from '@attest/contracts';

import { LocalError } from '../../errors/index.js';
import { loadProject, type LoadedProject } from '../../project/project-loader/index.js';
import type { SemanticProjectOperation } from '../../project/transaction/index.js';
import type { CommandResult, MutationResult } from '../shared/command-result.js';
import { executeProjectMutation } from '../shared/project-mutation.js';
import type { Prompt } from '../shared/prompt.js';
import { candidateFromLoadedProject, loadCommandProject } from '../project/load-command-project.js';
import { redactMetricResource } from '../show/redact-resource.js';
import { assertSafeMetricResource, readImportedMetricResource } from './authoring/index.js';

type MetricAuthoringRequest = Extract<
  CommandRequest,
  { command: 'metric.add' | 'metric.import' | 'metric.remove' | 'metric.rename' }
>;

type MetricMutationCommandOptions = {
  interactive: boolean;
  project?: string;
  prompt?: Prompt;
  readStdin: () => Promise<string>;
  request: MetricAuthoringRequest;
  workingDirectory: string;
};

type MutationBuildResult = {
  candidate: ProjectResources;
  metric: MetricResource;
  renames?: readonly { from: string; to: string; type: 'metric' }[];
  warnings?: string[];
};

/** Finds one authored metric or reports the missing id with a way to list them. */
const findMetric = (metrics: readonly MetricResource[], id: string): MetricResource => {
  const metric = metrics.find((candidate) => candidate.id === id);
  if (metric === undefined) {
    throw new LocalError('resource_not_found', `Metric ${id} was not found.`, {
      path: id,
      hint: 'Run `attest list metrics` to inspect available metric ids.',
    });
  }
  return metric;
};

const assertNewMetricId = (metrics: readonly MetricResource[], id: string): void => {
  if (metrics.some((metric) => metric.id === id)) {
    throw new LocalError('project_invalid', `Metric ${id} already exists.`, {
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
        throw new LocalError('project_invalid', 'Referenced metrics cannot be removed.', {
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
): Promise<CommandResult<'mutation', MutationResult>> => {
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
          throw new LocalError('cancelled', 'Metric mutation was not confirmed.');
        }
      } else if (destructive) {
        throw new LocalError('cli_missing_input', 'Metric removal requires confirmation.', {
          path: '--yes',
          hint: 'Pass --yes, set `yes: true`, or preview with --dry-run.',
        });
      }
    },
  });
  const dryRun = options.request.dry_run === true;
  return {
    operation: 'mutation',
    projectHashBefore: mutation.projectHashBefore,
    projectHashAfter: mutation.projectHashAfter,
    result: {
      committed: mutation.committed,
      dry_run: dryRun,
      resource: { id: built.metric.id, type: 'metric' },
      operations: mutation.diff.operations,
    },
    warnings: built.warnings?.map((message) => ({ code: 'metric_references_detached', message })),
  };
};

export {
  findMetric,
  runMetricMutationCommand,
  type MetricAuthoringRequest,
  type MetricMutationCommandOptions,
};
