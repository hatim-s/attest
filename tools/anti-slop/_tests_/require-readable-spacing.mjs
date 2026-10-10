import { RuleTester } from "./runtime.mjs";
import { requireReadableSpacingRule } from "../rules/require-readable-spacing.mjs";
import createPaddingLineRule from "../vendor/eslint-stylistic/padding-line-between-statements.mjs";
const tester = new RuleTester();
const error = { messageId: "expectedBlankLine" };
tester.run("anti-slop/require-readable-spacing", requireReadableSpacingRule, {
  valid: [
    `import { a } from 'a';
import { b } from 'b';

export const c = a + b;`,
    `function f() {
const a = 1;
const b = 2;

return a + b;
}`,
    "function f() { return 1; }",
    `function f(a: string): string;
function f(a: number): number;
function f(a: string | number) { return a; }`,
    `export function f(a: string): string;
export function f(a: number): number;
export function f(a: string | number) { return a; }`,
    `const f = Effect.gen(function* () {
const a = yield* A;
const b = yield* B;

return a + b;
});`,
    `export type A = string;

/** B documentation. */
export type B = number;`,
    "function f() { if (ok) { go(); } else { stop(); } }",
    `function f() {
// return docs
return 1;
}`,
    `const a = 1;


const b = 2;`,
    "switch (x) { case 1: case 2: go(); break; default: stop(); }"
  ],
  invalid: [
    { code: `const a = 1;
const b = 2;`, output: `const a = 1;

const b = 2;`, errors: [error] },
    {
      code: `export const a = 1;
/** B docs. */
export type B = number;`,
      output: `export const a = 1;

/** B docs. */
export type B = number;`,
      errors: [error]
    },
    {
      code: `const a = 1; // trailing
// leading
const b = 2;`,
      output: `const a = 1; // trailing

// leading
const b = 2;`,
      errors: [error]
    },
    { code: "const a = 1; const b = 2;", output: `const a = 1;

 const b = 2;`, errors: [error] },
    {
      code: `import { a } from 'a';
const b = a;`,
      output: `import { a } from 'a';

const b = a;`,
      errors: [error]
    },
    {
      code: `function f() {
const a = 1;
return a;
}`,
      output: `function f() {
const a = 1;

return a;
}`,
      errors: [error]
    },
    {
      code: `function f() {
const a = 1;
if (a) go();
}`,
      output: `function f() {
const a = 1;

if (a) go();
}`,
      errors: [error]
    },
    {
      code: `function f() {
if (ok) { go(); }
stop();
}`,
      output: `function f() {
if (ok) { go(); }

stop();
}`,
      errors: [error]
    },
    {
      code: `const f = Effect.gen(function* () {
const a = yield* A;
const b = yield* B;
const dispatch = Effect.fn('dispatch')(function* () {
yield* a;
});
return dispatch;
});`,
      output: `const f = Effect.gen(function* () {
const a = yield* A;
const b = yield* B;

const dispatch = Effect.fn('dispatch')(function* () {
yield* a;
});

return dispatch;
});`,
      errors: [error, error]
    },
    {
      code: `export interface A {}
export class B {}`,
      output: `export interface A {}

export class B {}`,
      errors: [error]
    },
    {
      code: `const a = 1
;[1].forEach(f)`,
      output: `const a = 1

;[1].forEach(f)`,
      errors: [error]
    },
    {
      code: `function f() {
foo();
while (ok) go();
}`,
      output: `function f() {
foo();

while (ok) go();
}`,
      errors: [error]
    }
  ]
});
tester.run("vendored padding removal", createPaddingLineRule([{ blankLine: "never", prev: "*", next: "*" }]), {
  valid: [`foo();
bar();`],
  invalid: [
    {
      code: `foo();

bar();`,
      output: `foo();
bar();`,
      errors: [{ messageId: "unexpectedBlankLine" }]
    },
    {
      code: `foo();

// comment

bar();`,
      output: null,
      errors: [{ messageId: "unexpectedBlankLine" }]
    }
  ]
});
