import { parseWithSchemaSync } from '@attest/contracts';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Schema from 'effect/Schema';

const fixtureFields = {
  description: Schema.String.check(Schema.isMinLength(1)),
  input: Schema.Json,
  preserve_paths: Schema.optional(Schema.Array(Schema.String)),
  absent_paths: Schema.optional(Schema.Array(Schema.String)),
};

const fixtureEnvelopeSchema = Schema.Union([
  Schema.Struct({ ...fixtureFields, expect: Schema.Literal('valid') }),
  Schema.Struct({
    ...fixtureFields,
    expect: Schema.Literal('invalid'),
    issue_paths: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
    json_schema_valid: Schema.optional(Schema.Literal(true)),
  }),
  Schema.Struct({
    ...fixtureFields,
    expect: Schema.Literal('valid-with-warnings'),
    warning_codes: Schema.Array(Schema.Literals(['unknown_field', 'invalid_trace'])).check(
      Schema.isMinLength(1),
    ),
  }),
]);

type FixtureEnvelope = typeof fixtureEnvelopeSchema.Type;

type LoadedFixture = { contract: string; name: string; envelope: FixtureEnvelope };

const fixtureRoot = join(import.meta.dirname, '../../../../../conformance/fixtures');

/**
 * Shares committed protocol inputs between public parser and emitted JSON Schema checks.
 * Conformance imports this loader directly, so moves must update both workspaces.
 */
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
              envelope: parseWithSchemaSync(
                fixtureEnvelopeSchema,
                JSON.parse(readFileSync(path, 'utf8')),
              ),
            };
          } catch (error) {
            throw new Error(`Invalid conformance fixture: ${path}`, { cause: error });
          }
        }),
    );

export { loadFixtures, type FixtureEnvelope, type LoadedFixture };
