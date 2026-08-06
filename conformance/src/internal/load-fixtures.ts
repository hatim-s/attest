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

const fixtureRoot = join(import.meta.dirname, '../..', 'fixtures');

/** Loads every JSON fixture at test startup so new files automatically join the compatibility gate. */
const loadFixtures = (): LoadedFixture[] =>
  readdirSync(fixtureRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((directory) =>
      readdirSync(join(fixtureRoot, directory.name), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((file) => ({
          contract: directory.name,
          name: file.name,
          envelope: JSON.parse(
            readFileSync(join(fixtureRoot, directory.name, file.name), 'utf8'),
          ) as FixtureEnvelope,
        })),
    );

export { loadFixtures, type FixtureEnvelope, type LoadedFixture };
