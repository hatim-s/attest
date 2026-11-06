import assert from 'node:assert/strict';
import { ESLint } from 'eslint';

const eslint = new ESLint();
const filePath = 'packages/contracts/src/_tests_/agent.test.ts';
const methods = [
  'parse',
  'safeParse',
  'parseAsync',
  'safeParseAsync',
  'decode',
  'safeDecode',
  'decodeAsync',
  'safeDecodeAsync',
  'encode',
  'safeEncode',
  'encodeAsync',
  'safeEncodeAsync',
];
const hits = async (code, path = filePath) => {
  const results = await eslint.lintText(code, { filePath: path });
  assert.equal(
    results.flatMap((result) => result.messages).filter((message) => message.fatal).length,
    0,
    code,
  );
  return results
    .flatMap((result) => result.messages)
    .filter((message) => message.ruleId === 'anti-slop/schema-decoding').length;
};
for (const expression of [
  ...methods.flatMap((method) => [`z.${method}(schema, value)`, `schema.${method}(value)`]),
  'schema.spa(value)',
  'const maybe = schema as z.ZodString | undefined; maybe?.safeParse(value)',
  'const maybe = schema as z.ZodString | null; maybe?.parse(value)',
  'function decode(s?: z.ZodType<string>) { return s?.safeDecode(value); }',
  'const holder: { schema?: z.ZodType } = { schema }; holder.schema?.safeParse(value)',
  "schema['parse'](value)",
  'const decode = schema.parse',
  'const alias = schema; alias.safeParse(value)',
  "const { 'parse': decode } = schema; decode(value)",
  "const { 'safeParse': decode } = z; decode(schema, value)",
  "const method = 'parse' as const; schema[method](value)",
  "const method = 'safeParse' as const; z[method](schema, value)",
  "const method = 'parse' as const; const { [method]: decode } = schema; decode(value)",
  'const { parse: decode } = schema; decode(value)',
  'const { safeParse: decode } = z; decode(schema, value)',
]) {
  const code = `import { z } from 'zod'; const schema = z.string(); const value = ''; ${expression};`;
  assert.equal(await hits(code), 1, expression);
}
for (const expression of [
  "JSON.parse('{}'); Date.parse('2026-01-01');",
  'function decode(d?: TextDecoder) { return d?.decode(); }',
  "function parse(p?: { parse(value: string): string }) { return p?.parse('a'); }",
  "const params = { parse: (value: string) => value }; params.parse('a');",
  "const params = { parse: (value: string) => value }; const { 'parse': decode } = params; decode('a');",
  "const params = { parse: (value: string) => value }; const method = 'parse' as const; params[method]('a');",
  "const params = { safeDecode: (value: string) => value }; params.safeDecode('a');",
])
  assert.equal(await hits(expression), 0, expression);

// Syntax-only ownership still applies when a file has no TypeScript program.
for (const path of [
  filePath,
  'scripts/block-source-publish.mjs',
  'tools/effect-probe/src/probe.ts',
]) {
  for (const method of methods) {
    assert.equal(
      await hits(`import { ${method} as decode } from 'zod';`, path),
      1,
      `${path} import ${method}`,
    );
    assert.equal(
      await hits(`export { ${method} as decode } from 'zod';`, path),
      1,
      `${path} export ${method}`,
    );
  }
}
console.log('Typed schema decoder ownership checks passed.');
