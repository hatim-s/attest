import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const fixtureFields = {
  description: z.string().min(1),
  input: z.json(),
  preserve_paths: z.array(z.string()).optional(),
  absent_paths: z.array(z.string()).optional(),
};

const fixtureEnvelopeSchema = z.discriminatedUnion('expect', [
  z.strictObject({ ...fixtureFields, expect: z.literal('valid') }),
  z.strictObject({
    ...fixtureFields,
    expect: z.literal('invalid'),
    issue_paths: z.array(z.string()).nonempty(),
    json_schema_valid: z.literal(true).optional(),
  }),
  z.strictObject({
    ...fixtureFields,
    expect: z.literal('valid-with-warnings'),
    warning_codes: z.array(z.enum(['unknown_field', 'invalid_trace'])).nonempty(),
  }),
]);

type FixtureEnvelope = z.infer<typeof fixtureEnvelopeSchema>;

type LoadedFixture = { contract: string; name: string; envelope: FixtureEnvelope };

const fixtureRoot = join(import.meta.dirname, '../../../../../conformance/fixtures');

/** Shares committed protocol inputs between public parser and emitted JSON Schema checks. */
const loadFixtures = (): LoadedFixture[] =>
  readdirSync(fixtureRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((directory) =>
      readdirSync(join(fixtureRoot, directory.name), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((file) => {
          const path = join(fixtureRoot, directory.name, file.name);

          try {
            return {
              contract: directory.name,
              name: file.name,
              envelope: fixtureEnvelopeSchema.parse(JSON.parse(readFileSync(path, 'utf8'))),
            };
          } catch (error) {
            throw new Error(`Invalid conformance fixture: ${path}`, { cause: error });
          }
        }),
    );

export { loadFixtures, type FixtureEnvelope, type LoadedFixture };
