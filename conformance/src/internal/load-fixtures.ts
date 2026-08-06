import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Describes one black-box input and the contract behavior it must retain. */
type FixtureEnvelope = {
  description: string;
  expect: 'valid' | 'invalid' | 'valid-with-warnings';
  issue_paths?: string[][];
  warning_codes?: string[];
  input: unknown;
};

/** Names a loaded fixture so tests can route it to the relevant public parser. */
type LoadedFixture = {
  contract: string;
  name: string;
  envelope: FixtureEnvelope;
};

const allowedExpectValues = new Set<FixtureEnvelope['expect']>([
  'valid',
  'invalid',
  'valid-with-warnings',
]);

/** Validates the shared fixture envelope before a fixture reaches a contract parser. */
const parseFixtureEnvelope = (value: unknown, path: string): FixtureEnvelope => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Fixture envelope must be an object: ${path}`);
  }

  const envelope = value as Record<string, unknown>;
  if (typeof envelope.description !== 'string' || envelope.description.length === 0) {
    throw new Error(`Fixture envelope is missing description: ${path}`);
  }
  if (!allowedExpectValues.has(envelope.expect as FixtureEnvelope['expect'])) {
    throw new Error(`Fixture envelope has invalid expect value: ${path}`);
  }
  if (!Object.hasOwn(envelope, 'input')) {
    throw new Error(`Fixture envelope is missing input: ${path}`);
  }

  return envelope as FixtureEnvelope;
};

const fixtureRoot = join(import.meta.dirname, '../..', 'fixtures');

/** Loads every JSON fixture at test startup so new files automatically join the compatibility gate. */
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
            parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
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
