import {
  commandRequestSchema,
  metricResourceSchema,
  metricTestFixtureSchema,
  type MetricResource,
  type MetricTestFixture,
} from '@attest/contracts';

import { AttestCliError } from '../../../errors/index.js';
import type { ReadInput } from '../../agent/agent-request.js';
import { parseJson, readTextSource, requestDiagnostics } from './source.js';
import { assertSafeMetricResource } from './validation.js';

/** Imports either one canonical metric resource or the metric inside a add request. */
const readImportedMetricResource = async (
  source: string,
  metricId: string,
  name: string | undefined,
  workingDirectory: string,
  readStdin: ReadInput,
): Promise<MetricResource> => {
  const value = parseJson(
    await readTextSource(source, '<path|->', workingDirectory, readStdin),
    '<path|->',
    'Provide one canonical metric resource or metric.add request.',
  );
  const request = commandRequestSchema.safeParse(value);
  const candidate =
    request.success && request.data.command === 'metric.add' ? request.data.metric : value;
  const parsed = metricResourceSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new AttestCliError('cli_usage', 'Imported metric JSON does not match its schema.', {
      path: '<path|->',
      details: { diagnostics: requestDiagnostics(parsed.error.issues) },
    });
  }
  const resource = { ...parsed.data, id: metricId, name: name?.trim() || parsed.data.name };
  assertSafeMetricResource(resource);
  return resource;
};

/** Reads and validates one complete local fixture before any metric process can start. */
const readMetricTestFixture = async (
  source: string,
  workingDirectory: string,
  readStdin: ReadInput,
): Promise<MetricTestFixture> => {
  const value = parseJson(
    await readTextSource(source, '--fixture', workingDirectory, readStdin),
    '--fixture',
    'Provide one attest.metric-test-fixture document.',
  );
  const parsed = metricTestFixtureSchema.safeParse(value);
  if (!parsed.success) {
    throw new AttestCliError(
      'project_invalid',
      'The local metric fixture does not match its schema.',
      {
        path: '--fixture',
        details: { diagnostics: requestDiagnostics(parsed.error.issues) },
      },
    );
  }
  return parsed.data;
};

export { readImportedMetricResource, readMetricTestFixture };
