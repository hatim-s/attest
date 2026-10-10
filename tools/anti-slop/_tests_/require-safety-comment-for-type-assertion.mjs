import { RuleTester } from "./runtime.mjs";
import { requireSafetyCommentForTypeAssertionRule } from "../rules/require-safety-comment-for-type-assertion.mjs";
const tester = new RuleTester();
const error = { messageId: "missingSafetyComment" };
tester.run("anti-slop/require-safety-comment-for-type-assertion (custom markers)", requireSafetyCommentForTypeAssertionRule, {
  valid: [
    {
      code: `// INVARIANT: The caller parsed this value.
const value = input as User;`,
      options: [{ markers: ["INVARIANT"] }]
    },
    {
      code: `// SAFETY: The caller parsed this value.
const value = input as User;`,
      options: [{ markers: ["INVARIANT", "SAFETY"] }]
    },
    {
      code: `// SAFE+: The caller parsed this value.
const value = input as User;`,
      options: [{ markers: ["SAFE+"] }]
    }
  ],
  invalid: [
    {
      code: `// SAFETY: This marker is not configured.
const value = input as User;`,
      options: [{ markers: ["INVARIANT"] }],
      errors: [error]
    },
    {
      code: `// INVARIANT:   
const value = input as User;`,
      options: [{ markers: ["INVARIANT"] }],
      errors: [error]
    }
  ]
});
tester.run("anti-slop/require-safety-comment-for-type-assertion", requireSafetyCommentForTypeAssertionRule, {
  valid: [
    "const values = [1, 2] as const;",
    "const value = <const>{ id: 'one' };",
    `// SAFETY: The parser established the UserId invariant.
const id = value as UserId;`,
    `function parse(): UserId {
// SAFETY: Validation above established the UserId invariant.
return value as UserId;
}`,
    "const id = /* SAFETY: Validation established the invariant. */ value as UserId;",
    `// SAFETY: The parser established the exported UserId invariant.
export const id = value as UserId;`,
    `/* SAFETY:
 * The parser established the exported UserId invariant.
 */
export const id = value as UserId;`
  ],
  invalid: [
    { code: "const id = value as UserId;", errors: [error] },
    { code: "const id = <UserId>value;", errors: [error] },
    { code: "const id = value as UserId; // SAFETY: Too late.", errors: [error] },
    {
      code: `// This cast seems fine.
const id = value as UserId;`,
      errors: [error]
    },
    { code: `// SAFETY:
const id = value as UserId;`, errors: [error] },
    { code: `// SAFETY:   
const id = value as UserId;`, errors: [error] },
    { code: "const id = /* SAFETY: */ value as UserId;", errors: [error] },
    { code: "export const id = value as UserId;", errors: [error] },
    {
      code: `// This is not a safety justification.
export const id = value as UserId;`,
      errors: [error]
    }
  ]
});
