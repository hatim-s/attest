import {
  parseAgentRequest,
  parseAgentResponse,
  parseMetricRequest,
  parseMetricResult,
  parseTrace,
} from '@attest/contracts';
import { describe, expect, it } from 'vitest';

import { loadFixtures, type FixtureEnvelope, type LoadedFixture } from './support/load-fixtures.js';

type FixtureParseResult =
  | { ok: true; value: unknown; warningCodes: string[] }
  | { ok: false; issuePaths: string[]; warningCodes: string[] };

type ContractIssueResult =
  { ok: true; value: unknown } | { ok: false; error: Array<{ path: string }> };

/** Adapts parsers that report no warnings to the shared fixture result. */
const withoutWarnings = (result: ContractIssueResult): FixtureParseResult =>
  result.ok
    ? { ok: true, value: result.value, warningCodes: [] }
    : { ok: false, issuePaths: result.error.map((issue) => issue.path), warningCodes: [] };

const parsers: Record<string, (input: unknown) => FixtureParseResult> = {
  'agent-request': (input) => withoutWarnings(parseAgentRequest(input)),
  'agent-response': (input) => {
    const result = parseAgentResponse(input);
    const warningCodes = result.warnings.map((warning) => warning.code);
    return result.ok
      ? { ok: true, value: result.value, warningCodes }
      : { ok: false, issuePaths: result.errors.map((issue) => issue.path), warningCodes };
  },
  'metric-request': (input) => withoutWarnings(parseMetricRequest(input)),
  'metric-result': (input) => withoutWarnings(parseMetricResult(input)),
  trace: (input) => withoutWarnings(parseTrace(input)),
};

/** Routes a fixture to the public parser for its directory. Unknown directories fail the run. */
const parseFixture = (fixture: LoadedFixture): FixtureParseResult => {
  const parser = parsers[fixture.contract];
  if (parser === undefined) {
    throw new Error(`No parser for fixture directory "${fixture.contract}".`);
  }
  return parser(fixture.envelope.input);
};

/** Reads a dotted path such as `spans.0.vendor_span` from parsed JSON. */
const readPath = (value: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (current, key) =>
        current !== null && typeof current === 'object'
          ? (current as Record<string, unknown>)[key]
          : undefined,
      value,
    );

/** Asserts the outcome the envelope declares. */
const expectFixtureOutcome = (envelope: FixtureEnvelope, result: FixtureParseResult): void => {
  if (envelope.expect === 'invalid') {
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issuePaths).toEqual(expect.arrayContaining(envelope.issue_paths ?? []));
    return;
  }

  expect(result.ok).toBe(true);
  if (!result.ok) return;

  const expectedWarnings = envelope.expect === 'valid-with-warnings' ? envelope.warning_codes : [];
  expect(result.warningCodes).toEqual(expectedWarnings ?? []);
  for (const path of envelope.preserve_paths ?? []) {
    const authored = readPath(envelope.input, path);
    expect(authored, path).toBeDefined();
    expect(readPath(result.value, path), path).toEqual(authored);
  }
};

const fixtures = loadFixtures();
// Group by directory on disk so a fixture folder without a parser fails instead of being skipped.
const contracts = [...new Set(fixtures.map((fixture) => fixture.contract))];

for (const contract of contracts) {
  const contractFixtures = fixtures.filter((fixture) => fixture.contract === contract);

  describe(`${contract} conformance fixtures`, () => {
    it.each(contractFixtures)('$name: $envelope.description', (fixture) => {
      expectFixtureOutcome(fixture.envelope, parseFixture(fixture));
    });
  });
}
