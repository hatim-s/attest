import assert from 'node:assert/strict';
import { ESLint } from 'eslint';

const eslint = new ESLint();

const filePath = 'packages/contracts/src/_tests_/agent.test.ts';

const methods = [
  'is',
  'asserts',
  ...['Effect', 'Exit', 'Option', 'Result', 'Promise', 'Sync'].flatMap((suffix) => [
    `decode${suffix}`,
    `decodeUnknown${suffix}`,
  ]),
];

/** Exercise the actual flat config, including typed provenance and owner exceptions. */
async function hits(code, path = filePath) {
  const results = await eslint.lintText(code, { filePath: path });
  const messages = results.flatMap((result) => result.messages);
  assert.equal(messages.filter((message) => message.fatal).length, 0, code);

  return messages.filter((message) => message.ruleId === 'anti-slop/schema-decoding').length;
}

for (const method of methods) {
  for (const module of ['Schema', 'SchemaParser']) {
    // SchemaParser's Option adapters are internal and absent from the public d.ts.
    if (module === 'SchemaParser' && method.endsWith('Option')) continue;

    for (const expression of [
      `S.${method}(S.String)`,
      `S['${method}']`,
      `const key = '${method}' as const; S[key]`,
      `const alias = S; alias.${method}`,
      `const { ${method}: decode } = S`,
      `let decode; ({ ${method}: decode } = S)`,
      `function use({ ${method}: decode }: typeof S) {}`,
      `function use({ ${method}: decode }: typeof S = S) {}`,
      `let decode; for ({ ${method}: decode } of [S]) {}`,
      `let decode; for ({ ${method}: decode } of new Set([S])) {}`,
      `declare const values: Iterable<typeof S>; let decode; for ({ ${method}: decode } of values) {}`,
      `const [{ ${method}: decode }] = [S]`,
      `for (const { ${method}: decode } of [S]) {}`,
      `const holder = { schema: S }; const { schema: { ${method}: decode } } = holder`,
      `function use({ schema: { ${method}: decode } }: { schema: typeof S }) {}`,
      `let decode; ({ schema: { ${method}: decode } } = { schema: S })`,
      `const maybe: typeof S | undefined = S; maybe?.${method}`,
    ])
      assert.equal(
        await hits(`import * as S from 'effect/${module}'; ${expression};`),
        1,
        `${module}: ${expression}`,
      );
  }
}

for (const expression of [
  'E.Schema.decodeUnknownSync',
  "E['Schema']['decodeUnknownSync']",
  'const { Schema: { decodeUnknownSync: decode } } = E',
  'let decode; ({ Schema: { decodeUnknownSync: decode } } = E)',
  'for (const { Schema: { decodeUnknownSync: decode } } of [E]) {}',
  'function use({ Schema: { decodeUnknownSync: decode } }: typeof E) {}',
])
  assert.equal(await hits(`import * as E from 'effect'; ${expression};`), 1, expression);

// Check a foreign object's declared method types without introducing a second
// direct decoder reference in the same file.
for (const expression of [
  'holder.decode',
  'holder?.decode',
  "holder['decode']",
  'const { decode } = holder',
  'const alias = holder; alias.decode',
  'function use({ decode }: typeof holder) {}',
  'for (const { decode } of [holder]) {}',
  'let decode; ({ decode } = holder)',
]) {
  const code = `declare const holder: { decode: typeof import('effect/Schema').decodeUnknownSync }; ${expression};`;
  assert.equal(await hits(code), 1, expression);
}

for (const code of [
  "import { Schema as S } from 'effect'; S.decodeUnknownSync",
  "import { SchemaParser as S } from 'effect'; S.decodeUnknownSync",
  "import * as S from 'effect/Schema'; const maybe: { schema?: typeof S } = {}; maybe.schema?.decodeUnknownSync",
])
  assert.equal(await hits(code), 1, code);

// Syntax-only imports and exports do not need dependency resolution, including
// the retained legacy Zod ban. Zod is no longer a contracts dependency.
for (const path of [
  filePath,
  'scripts/block-source-publish.mjs',
  'tools/effect-probe/src/ownership-check.ts',
]) {
  for (const module of ['effect/Schema', 'effect/SchemaParser']) {
    for (const method of methods) {
      for (const keyword of ['import', 'export']) {
        const code = `${keyword} { ${method} as decode } from '${module}';`;
        assert.equal(await hits(code, path), 1, `${path}: ${code}`);
      }
    }
  }

  for (const module of ['effect', 'effect/Schema', 'effect/SchemaParser', 'zod', 'zod/v4']) {
    for (const clause of ['*', '* as Decoders']) {
      const code = `export ${clause} from '${module}';`;
      assert.equal(await hits(code, path), 1, `${path}: ${code}`);
    }
  }

  for (const method of [
    'parse',
    'safeParse',
    'parseAsync',
    'safeParseAsync',
    'spa',
    'decode',
    'safeDecode',
    'decodeAsync',
    'safeDecodeAsync',
    'encode',
    'safeEncode',
    'encodeAsync',
    'safeEncodeAsync',
  ]) {
    for (const keyword of ['import', 'export']) {
      const code = `${keyword} { ${method} as decode } from 'zod';`;
      assert.equal(await hits(code, path), 1, code);
    }

    assert.equal(await hits(`import { z } from 'zod'; z.${method};`, path), 1);
  }

  for (const code of [
    "import * as S from 'effect/Schema'; S?.['decodeSync']",
    "import * as E from 'effect'; E.Schema.decodeSync",
    "import { Schema as S } from 'effect'; const alias = S; alias.decodeSync",
    "import * as S from 'effect/Schema'; const { decodeSync: decode } = S",
    "import * as S from 'effect/Schema'; let decode; ({ decodeSync: decode } = S)",
  ])
    assert.equal(await hits(code, path), 1, `${path}: ${code}`);
}

for (const code of [
  "declare const obj: { [K in 'value']: string }; const { value } = obj;",
  "JSON.parse('{}'); Date.parse('2026-01-01');",
  'function use(d?: TextDecoder) { return d?.decode(); }',
  "declare const router: { parse(value: string): unknown }; router.parse('x');",
  'declare const command: { parseAsync(): Promise<void> }; command.parseAsync();',
  "const helper = { decodeUnknownSync: (x: string) => x }; helper.decodeUnknownSync('x');",
  'const helper = { decodeUnknownSync: (x: string) => x }; const { decodeUnknownSync } = helper;',
  "import { Schema as S } from 'effect'; S.decodeTo(S.Number); S.decode({}); S.encode({}); S.encodeTo(S.String);",
  "import { Schema as S } from 'effect'; S.Struct({ value: S.String }); S.String.check(S.isMinLength(1));",
  "import { Schema as S } from 'effect'; S.toStandardSchemaV1(S.String);",
  "import { Schema as S } from 'effect'; const S2 = { decodeUnknownSync: (x: string) => x }; S2.decodeUnknownSync('x');",
  "import { Schema as S } from 'effect'; function use(S: { decodeSync(): void }) { S.decodeSync(); }",
  "import { parseWithSchema, parseWithSchemaEffect, parseWithSchemaSync } from '@attest/contracts';",
  "export { decodeTo, decode, toStandardSchemaV1 } from 'effect/Schema';",
  "export type * from 'effect/Schema';",
  "import type { decodeUnknownSync } from 'effect/Schema';",
])
  assert.equal(await hits(code), 0, code);

for (const path of [
  'packages/contracts/src/schema/parse.ts',
  'packages/contracts/src/project/shared.ts',
])
  assert.equal(
    await hits("import { Schema } from 'effect'; Schema.decodeUnknownEffect(Schema.String);", path),
    0,
    path,
  );

console.log('Native and legacy schema decoder ownership checks passed.');
