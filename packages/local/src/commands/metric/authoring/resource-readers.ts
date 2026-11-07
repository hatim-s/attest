import * as Effect from 'effect/Effect';
import { valueFromExit } from '../../../internal/effect-exit.js';
import {
  parseWithSchema,
  commandRequestSchema,
  metricResourceSchema,
  metricTestFixtureSchema,
  type MetricResource,
  type MetricTestFixture,
} from '@attest/contracts';

import { LocalError } from '../../../errors/index.js';
import { schemaIssueDiagnostics } from '../../../internal/schema-issue-diagnostics.js';
import { parseJsonText, readSourceText } from '../../../internal/source-text.js';
import type { ReadInput } from '../../agent/authoring/types.js';
import { assertSafeMetricResource } from './validation.js';

/** Imports either one canonical metric resource or the metric inside a add request. */
const readImportedMetricResource = async (
  source: string,
  metricId: string,
  name: string | undefined,
  workingDirectory: string,
  readStdin: ReadInput,
): Promise<MetricResource> => {
  // EFFECT-BRIDGE(S8b)
  const text = await Effect.runPromiseExit(
    readSourceText(source, { path: '<path|->', readStdin, workingDirectory }),
  ).then((exit) => valueFromExit(exit));

  const value = parseJsonText(text, {
    path: '<path|->',
    hint: 'Provide one canonical metric resource or metric.add request.',
  });

  const request = parseWithSchema(commandRequestSchema, value);

  const candidate =
    request.ok && request.value.command === 'metric.add' ? request.value.metric : value;

  const parsed = parseWithSchema(metricResourceSchema, candidate);

  if (!parsed.ok) {
    throw new LocalError('cli_usage', 'Imported metric JSON does not match its schema.', {
      path: '<path|->',
      details: { diagnostics: schemaIssueDiagnostics(parsed.error.issues) },
    });
  }

  const resource = { ...parsed.value, id: metricId, name: name?.trim() || parsed.value.name };
  assertSafeMetricResource(resource);

  return resource;
};

/** Reads and validates one complete local fixture before any metric process can start. */
const readMetricTestFixture = async (
  source: string,
  workingDirectory: string,
  readStdin: ReadInput,
): Promise<MetricTestFixture> => {
  // EFFECT-BRIDGE(S8b)
  const text = await Effect.runPromiseExit(
    readSourceText(source, { path: '--fixture', readStdin, workingDirectory }),
  ).then((exit) => valueFromExit(exit));

  const value = parseJsonText(text, {
    path: '--fixture',
    hint: 'Provide one attest.metric-test-fixture document.',
  });

  const parsed = parseWithSchema(metricTestFixtureSchema, value);

  if (!parsed.ok) {
    throw new LocalError('project_invalid', 'The local metric fixture does not match its schema.', {
      path: '--fixture',
      details: { diagnostics: schemaIssueDiagnostics(parsed.error.issues) },
    });
  }

  return parsed.value;
};

export { readImportedMetricResource, readMetricTestFixture };
