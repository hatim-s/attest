import * as Effect from 'effect/Effect';
import type { StoredMetricEvaluation } from '@attest/core';
import type { MetricContext } from '@attest/runtime';

import { LocalError, classifyForeignFailure } from '../../errors/index.js';
import { redactProbeValue } from '../agent/adapter/evidence-redaction.js';
import { evaluateMetricResource } from '../eval/eval-metric-runner.js';
import { loadCommandProject } from '../project/load-command-project.js';
import { findResource } from '../shared/resource-lookup.js';
import { readMetricTestFixture } from './authoring/index.js';

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

/** Drops the timing so repeated fixture runs produce identical results. */
const withoutDuration = (evaluation: StoredMetricEvaluation) => {
  const { durationMs: _duration, ...evidence } = evaluation;
  void _duration;

  return evidence;
};

/** Tests assertions or trusted argv locally; judge and HTTP definitions remain inspection-only. */
const runMetricTestCommand = Effect.fn('runMetricTestCommand')(function* (
  options: MetricTestCommandOptions,
) {
  const loaded = yield* loadCommandProject(options);
  const metric = yield* findResource('metric', loaded.metrics, options.metricId ?? '');

  const fixture = yield* readMetricTestFixture(
    options.fixture,
    options.workingDirectory,
    options.readStdin,
  );

  if (metric.definition.kind === 'judge' || metric.definition.kind === 'http') {
    return {
      operation: 'metric-test' as const,
      projectHashBefore: loaded.projectHash,
      projectHashAfter: loaded.projectHash,
      result: {
        metric_id: metric.id,
        kind: metric.definition.kind,
        fixture_valid: true as const,
        executed: false as const,
        reason: 'external_execution_not_supported' as const,
      },
    };
  }

  let caseDefinition: MetricContext['caseDefinition'] = {
    id: fixture.case.id,
    input: fixture.case.input,
  };

  if (fixture.case.expected !== undefined) {
    caseDefinition = { ...caseDefinition, expected: fixture.case.expected };
  }

  if (fixture.case.params !== undefined) {
    caseDefinition = { ...caseDefinition, params: fixture.case.params };
  }

  const context: MetricContext = {
    caseDefinition,
    execution: {
      outcome: 'completed',
      output: fixture.output,
      trace: fixture.trace,
      artifacts: [...(fixture.artifacts ?? [])],
    },
  };

  const { evaluation, secrets } = yield* evaluateMetricResource({
    context,
    definition: metric.definition,
    id: metric.id,
    projectRoot: loaded.root,
    signal: options.signal,
  }).pipe(Effect.mapError(classifyForeignFailure));

  const redacted = redactProbeValue(withoutDuration(evaluation), secrets);

  if (evaluation.status === 'error') {
    return yield* new LocalError(
      'metric_infrastructure_failed',
      'Metric fixture execution failed.',
      {
        path: metric.id,
        hint: 'Inspect the redacted local evaluation details and repair the executable fixture.',
        details: { evaluation: redacted },
      },
    );
  }

  const passed = evaluation.status === 'evaluated' ? evaluation.pass : false;

  if (passed !== fixture.expected_pass) {
    return yield* new LocalError(
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
    operation: 'metric-test' as const,
    projectHashBefore: loaded.projectHash,
    projectHashAfter: loaded.projectHash,
    result: {
      metric_id: metric.id,
      kind: metric.definition.kind,
      fixture_valid: true as const,
      executed: true as const,
      expected_pass: fixture.expected_pass,
      evaluation: redacted,
    },
  };
});

export { runMetricTestCommand, type MetricTestCommandOptions };
