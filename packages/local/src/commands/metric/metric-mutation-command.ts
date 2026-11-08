import * as Effect from 'effect/Effect';
import type { CommandRequest, MetricResource, ProjectResources } from '@attest/contracts';

import { LocalError } from '../../errors/index.js';
import { loadProject, type LoadedProject } from '../../project/project-loader/index.js';
import type { SemanticProjectOperation } from '../../project/transaction/index.js';
import type { CommandResult, MutationResult } from '../shared/command-result.js';
import { executeProjectMutation } from '../shared/project-mutation.js';
import type { Prompt } from '../shared/prompt.js';
import { assertNewId, findResource } from '../shared/resource-lookup.js';
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
): ProjectResources => {
  const rewriteCases = (cases: ProjectResources['tests'][number]['cases']) =>
    cases.map((testCase) => {
      if (testCase.metric_overrides === undefined) return testCase;

      return {
        ...testCase,
        metric_overrides:
          to === undefined
            ? testCase.metric_overrides.filter(({ metric_id }) => metric_id !== from)
            : testCase.metric_overrides.map((override) =>
                override.metric_id === from ? { ...override, metric_id: to } : override,
              ),
      };
    });

  return {
    ...project,
    tests: project.tests.map((test) => ({
      ...test,
      metrics:
        to === undefined
          ? test.metrics.filter(({ metric_id }) => metric_id !== from)
          : test.metrics.map((reference) =>
              reference.metric_id === from ? { ...reference, metric_id: to } : reference,
            ),
      cases: rewriteCases(test.cases),
    })),
    datasets: project.datasets.map((dataset) => ({
      ...dataset,
      cases: rewriteCases(dataset.cases),
    })),
  };
};

/** Builds and cross-validates the complete project candidate before transactional publication. */
const buildMetricMutation = Effect.fn('buildMetricMutation')(function* (
  loaded: LoadedProject,
  request: MetricAuthoringRequest,
  options: MetricMutationCommandOptions,
) {
  let candidate = candidateFromLoadedProject(loaded);

  switch (request.command) {
    case 'metric.add':
      yield* assertSafeMetricResource(request.metric);
      yield* assertNewId('metric', candidate.metrics, request.metric.id);
      candidate = { ...candidate, metrics: [...candidate.metrics, request.metric] };

      return { candidate, metric: request.metric } satisfies MutationBuildResult;
    case 'metric.import': {
      yield* assertNewId('metric', candidate.metrics, request.as);

      const metric = yield* readImportedMetricResource(
        request.source,
        request.as,
        request.name,
        options.workingDirectory,
        options.readStdin,
      );

      candidate = { ...candidate, metrics: [...candidate.metrics, metric] };

      return { candidate, metric } satisfies MutationBuildResult;
    }

    case 'metric.rename': {
      let metric = yield* findResource('metric', candidate.metrics, request.metric_id);
      yield* assertNewId('metric', candidate.metrics, request.new_id);
      metric = { ...metric, id: request.new_id };
      candidate = {
        ...candidate,
        metrics: candidate.metrics.map((entry) =>
          entry.id === request.metric_id ? metric : entry,
        ),
      };
      candidate = rewriteMetricReferences(candidate, request.metric_id, request.new_id);

      return {
        candidate,
        metric,
        renames: [{ from: request.metric_id, to: request.new_id, type: 'metric' as const }],
      } satisfies MutationBuildResult;
    }

    case 'metric.remove': {
      const metric = yield* findResource('metric', candidate.metrics, request.metric_id);
      const references = metricReferencePaths(candidate, request.metric_id);

      if (references.length > 0 && request.detach !== true) {
        return yield* new LocalError('project_invalid', 'Referenced metrics cannot be removed.', {
          path: request.metric_id,
          hint: 'Detach the metric from every test and case, or pass `--detach` explicitly.',
          details: { reference_paths: references },
        });
      }

      candidate = {
        ...candidate,
        metrics: candidate.metrics.filter(({ id }) => id !== request.metric_id),
      };

      if (request.detach === true)
        candidate = rewriteMetricReferences(candidate, request.metric_id, undefined);

      return {
        candidate,
        metric,
        warnings:
          references.length === 0
            ? undefined
            : [`Detached ${references.length} metric references before removal.`],
      } satisfies MutationBuildResult;
    }
  }
});

const renderOperations = (operations: readonly SemanticProjectOperation[]): string =>
  operations
    .map((operation) => {
      const previous = operation.previous_id === undefined ? '' : ` from ${operation.previous_id}`;

      return `  ${operation.op} ${operation.resource.type} ${operation.resource.id}${previous}`;
    })
    .join('\n');

/** Applies the shared preview-confirm-publish pipeline with the observed hash as commit guard. */
const runMetricMutationCommand = Effect.fn('runMetricMutationCommand')(function* (
  options: MetricMutationCommandOptions,
) {
  // Dry-run must not acquire a write-capable reader lock or recover transaction journals.
  const loaded = yield* options.request.dry_run === true
    ? loadProject({ project: options.project, workingDirectory: options.workingDirectory })
    : loadCommandProject({
        project: options.project,
        workingDirectory: options.workingDirectory,
      });

  const built = yield* buildMetricMutation(loaded, options.request, options);

  const mutationOptions = {
    candidate: built.candidate,
    expectedProjectHash: options.request.if_project_hash ?? loaded.projectHash,
    projectRoot: loaded.root,
    renames: built.renames,
    warnings: built.warnings,
  };

  const destructive = options.request.command === 'metric.remove';

  const mutation = yield* executeProjectMutation({
    dryRun: options.request.dry_run === true,
    mutation: mutationOptions,
    confirm: (preview) =>
      Effect.gen(function* () {
        if (options.request.yes === true) return;

        if (options.interactive && options.prompt !== undefined) {
          const resourcePreview = destructive
            ? `Remove metric ${built.metric.id}`
            : JSON.stringify(redactMetricResource(built.metric), undefined, 2);

          const answer = (yield* options.prompt(
            `${resourcePreview}\nSemantic diff:\n${renderOperations(preview.diff.operations)}\nApply these changes? [y/N]: `,
          ))
            .trim()
            .toLowerCase();

          if (answer !== 'y' && answer !== 'yes') {
            return yield* new LocalError('cancelled', 'Metric mutation was not confirmed.');
          }
        } else if (destructive) {
          return yield* new LocalError(
            'cli_missing_input',
            'Metric removal requires confirmation.',
            {
              path: '--yes',
              hint: 'Pass --yes, set `yes: true`, or preview with --dry-run.',
            },
          );
        }
      }),
  });

  const dryRun = options.request.dry_run === true;

  return {
    operation: 'mutation' as const,
    projectHashBefore: mutation.projectHashBefore,
    projectHashAfter: mutation.projectHashAfter,
    result: {
      committed: mutation.committed,
      dry_run: dryRun,
      resource: { id: built.metric.id, type: 'metric' as const },
      operations: mutation.diff.operations,
    },
    warnings: built.warnings?.map((message) => ({ code: 'metric_references_detached', message })),
  } satisfies CommandResult<'mutation', MutationResult>;
});

export { runMetricMutationCommand, type MetricAuthoringRequest, type MetricMutationCommandOptions };
