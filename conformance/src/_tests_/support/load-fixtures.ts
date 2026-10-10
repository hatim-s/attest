import { isString } from '@attest/contracts';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** One fixture file. Paths are dotted, matching parser diagnostics such as `spans.0.span_id`. */
type FixtureEnvelope = {
  description: string;
  expect: 'valid' | 'invalid' | 'valid-with-warnings';
  issue_paths?: string[];
  preserve_paths?: string[];
  warning_codes?: string[];
  input: unknown;
};

/** Names a loaded fixture so tests can route it to the relevant public parser. */
type LoadedFixture = {
  contract: string;
  name: string;
  envelope: FixtureEnvelope;
};

// BOUNDARY: Fixture JSON object fields remain untyped until the envelope's field validators run.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);

/** Validates the shared fixture envelope before a fixture reaches its contract parser. */
// BOUNDARY: Committed fixture JSON must declare an expected outcome, input and valid diagnostic path lists.
const parseFixtureEnvelope = (value: unknown, path: string): FixtureEnvelope => {
  if (!isRecord(value)) throw new Error(`Fixture envelope must be an object: ${path}`);

  if (!isString(value.description) || value.description.length === 0)
    throw new Error(`Fixture envelope is missing description: ${path}`);

  if (
    value.expect !== 'valid' &&
    value.expect !== 'invalid' &&
    value.expect !== 'valid-with-warnings'
  )
    throw new Error(`Fixture envelope has invalid expect value: ${path}`);

  if (!Object.hasOwn(value, 'input')) throw new Error(`Fixture envelope is missing input: ${path}`);

  const result: FixtureEnvelope = {
    description: value.description,
    expect: value.expect,
    input: value.input,
  };

  for (const key of ['issue_paths', 'preserve_paths', 'warning_codes'] as const) {
    const field = value[key];

    if (field === undefined) continue;

    if (!isStringList(field)) throw new Error(`Fixture envelope has invalid ${key}: ${path}`);
    result[key] = field;
  }

  return result;
};

const fixtureRoot = join(import.meta.dirname, '../../..', 'fixtures');

/** Loads every JSON fixture at test startup so new files automatically join the conformance gate. */
const loadFixtures = (): LoadedFixture[] =>
  readdirSync(fixtureRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((directory) =>
      readdirSync(join(fixtureRoot, directory.name), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((file) => {
          const path = join(fixtureRoot, directory.name, file.name);
          let parsed: unknown;

          try {
            parsed = JSON.parse(readFileSync(path, 'utf8'));
          } catch (error) {
            throw new Error(`Fixture JSON is unparseable: ${path}`, { cause: error });
          }

          return {
            contract: directory.name,
            name: file.name,
            envelope: parseFixtureEnvelope(parsed, path),
          };
        }),
    );

export { loadFixtures, type FixtureEnvelope, type LoadedFixture };
