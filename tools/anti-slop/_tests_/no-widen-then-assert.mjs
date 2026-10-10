import { RuleTester } from "./runtime.mjs";
import { noWidenThenAssertRule } from "../rules/no-widen-then-assert.mjs";
const tester = new RuleTester();
const error = { messageId: "widenThenAssert" };
tester.run("anti-slop/no-widen-then-assert", noWidenThenAssertRule, {
  valid: [
    "const source = { id: 'first' }; const widened: unknown = source;",
    "declare const input: unknown; const parsed = input as { readonly id: string };"
  ],
  invalid: [
    {
      code: "const source = { id: 'second' }; const widened: unknown = source; const parsed = widened as { readonly id: string };",
      errors: [error]
    }
  ]
});
