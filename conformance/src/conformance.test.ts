import {
  parseAgentRequest,
  parseAgentResponse,
  parseConfig,
  parseMetricRequest,
  parseMetricResult,
  parseTrace,
} from '@attest/contracts';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  loadFixtures,
  type FixtureEnvelope,
  type LoadedFixture,
} from './internal/load-fixtures.js';

type FixtureParseResult =
  | { ok: true; warningCodes: string[] }
  | { ok: false; issuePaths: string[]; warningCodes: string[] };

const fixtures = loadFixtures();
const fixtureRoot = join(import.meta.dirname, '../fixtures');

/** Converts public parser results into the few assertions every fixture envelope shares. */
const parseFixture = (fixture: LoadedFixture): FixtureParseResult => {
  if (fixture.contract === 'agent-request') {
    const result = parseAgentRequest(fixture.envelope.input);
    return result.ok
      ? { ok: true, warningCodes: [] }
      : { ok: false, issuePaths: result.error.map((issue) => issue.path), warningCodes: [] };
  }

  if (fixture.contract === 'agent-response') {
    const result = parseAgentResponse(fixture.envelope.input);
    const warningCodes = result.warnings.map((warning) => warning.code);
    return result.ok
      ? { ok: true, warningCodes }
      : { ok: false, issuePaths: result.errors.map((issue) => issue.path), warningCodes };
  }

  if (fixture.contract === 'config') {
    const result = parseConfig(fixture.envelope.input);
    return result.ok
      ? { ok: true, warningCodes: [] }
      : { ok: false, issuePaths: result.error.map((issue) => issue.path), warningCodes: [] };
  }

  if (fixture.contract === 'metric-request') {
    const result = parseMetricRequest(fixture.envelope.input);
    return result.ok
      ? { ok: true, warningCodes: [] }
      : { ok: false, issuePaths: result.error.map((issue) => issue.path), warningCodes: [] };
  }

  if (fixture.contract === 'metric-result') {
    const result = parseMetricResult(fixture.envelope.input);
    return result.ok
      ? { ok: true, warningCodes: [] }
      : { ok: false, issuePaths: result.error.map((issue) => issue.path), warningCodes: [] };
  }

  const result = parseTrace(fixture.envelope.input);
  return result.ok
    ? { ok: true, warningCodes: [] }
    : { ok: false, issuePaths: result.error.map((issue) => issue.path), warningCodes: [] };
};

/** Joins fixture path segments because the public parser intentionally exposes dot-path diagnostics. */
const formatFixturePath = (path: string[]): string => path.join('.');

/** Asserts the declared outcome without coupling fixtures to Zod implementation details. */
const expectFixtureOutcome = (envelope: FixtureEnvelope, result: FixtureParseResult): void => {
  if (envelope.expect === 'invalid') {
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    const expectedPaths = (envelope.issue_paths ?? []).map(formatFixturePath);
    expect(result.issuePaths).toEqual(expect.arrayContaining(expectedPaths));
    return;
  }

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  if (envelope.expect === 'valid-with-warnings') {
    expect(result.warningCodes).toEqual(envelope.warning_codes ?? []);
    return;
  }

  expect(result.warningCodes).toEqual([]);
};

const contractDirectories = [
  'agent-request',
  'agent-response',
  'config',
  'trace',
  'metric-request',
  'metric-result',
] as const;

it('contains exactly the known contract directories with JSON fixtures', () => {
  const actualDirectories = readdirSync(fixtureRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  expect(actualDirectories).toEqual([...contractDirectories].sort());

  for (const contract of contractDirectories) {
    const jsonFixtures = readdirSync(join(fixtureRoot, contract), { withFileTypes: true }).filter(
      (entry) => entry.isFile() && entry.name.endsWith('.json'),
    );
    expect(jsonFixtures.length, `${contract} fixture count`).toBeGreaterThan(0);
  }
});

for (const contract of contractDirectories) {
  const contractFixtures = fixtures.filter((fixture) => fixture.contract === contract);

  describe(`${contract} conformance fixtures`, () => {
    it.each(contractFixtures)('$name: $envelope.description', (fixture) => {
      expectFixtureOutcome(fixture.envelope, parseFixture(fixture));
    });
  });
}

describe('trace extension conformance', () => {
  it('round-trips unknown document and span fields from trace fixture 06', () => {
    const fixture = fixtures.find(
      (candidate) =>
        candidate.contract === 'trace' &&
        candidate.name === '06-valid-unknown-span-fields-preserved.json',
    );
    expect(fixture).toBeDefined();
    if (fixture === undefined) {
      return;
    }

    const result = parseTrace(fixture.envelope.input);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const input = fixture.envelope.input as {
      vendor_document: unknown;
      spans: Array<{ vendor_span: unknown }>;
    };
    expect(result.value.vendor_document).toEqual(input.vendor_document);
    expect(result.value.spans[0]?.vendor_span).toEqual(input.spans[0]?.vendor_span);
  });
});
