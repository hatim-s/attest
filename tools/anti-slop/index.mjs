import { noArrayFilterMapRule } from "./rules/no-array-filter-map.mjs";
import { noReduceAccumulatorCopyRule } from "./rules/no-reduce-accumulator-copy.mjs";
import { noChainedTypeAssertionsRule } from "./rules/no-chained-type-assertions.mjs";
import { noConditionalEmptyObjectSpreadRule } from "./rules/no-conditional-empty-object-spread.mjs";
import { noKnownValueWideningRule } from "./rules/no-known-value-widening.mjs";
import { noModuleMockingRule } from "./rules/no-module-mocking.mjs";
import { noObjectParametersRule } from "./rules/no-object-parameters.mjs";
import { noReflectApplyRule } from "./rules/no-reflect-apply.mjs";
import { noReflectGetRule } from "./rules/no-reflect-get.mjs";
import { noRuntimeTypeofRule } from "./rules/no-runtime-typeof.mjs";
import { noForbiddenTermInSymbolNamesRule } from "./rules/no-shape-in-symbol-names.mjs";
import { noUnknownParametersRule } from "./rules/no-unknown-parameters.mjs";
import { noUnknownReturnsRule } from "./rules/no-unknown-returns.mjs";
import { noUnknownTypeAliasesRule } from "./rules/no-unknown-type-aliases.mjs";
import { noUnsafeDictionaryTypeRule } from "./rules/no-unsafe-dictionary-type.mjs";
import { noWidenThenAssertRule } from "./rules/no-widen-then-assert.mjs";
import { requireReadableSpacingRule } from "./rules/require-readable-spacing.mjs";
import { requireSafetyCommentForTypeAssertionRule } from "./rules/require-safety-comment-for-type-assertion.mjs";
const antiSlopPlugin = {
  meta: { name: "anti-slop" },
  rules: {
    "no-array-filter-map": noArrayFilterMapRule,
    "no-reduce-accumulator-copy": noReduceAccumulatorCopyRule,
    "no-chained-type-assertions": noChainedTypeAssertionsRule,
    "no-conditional-empty-object-spread": noConditionalEmptyObjectSpreadRule,
    "no-known-value-widening": noKnownValueWideningRule,
    "no-module-mocking": noModuleMockingRule,
    "no-object-parameters": noObjectParametersRule,
    "no-reflect-apply": noReflectApplyRule,
    "no-reflect-get": noReflectGetRule,
    "no-runtime-typeof": noRuntimeTypeofRule,
    "no-unsafe-dictionary-type": noUnsafeDictionaryTypeRule,
    "no-shape-in-symbol-names": noForbiddenTermInSymbolNamesRule,
    "no-unknown-parameters": noUnknownParametersRule,
    "no-unknown-returns": noUnknownReturnsRule,
    "no-unknown-type-aliases": noUnknownTypeAliasesRule,
    "no-widen-then-assert": noWidenThenAssertRule,
    "require-readable-spacing": requireReadableSpacingRule,
    "require-safety-comment-for-type-assertion": requireSafetyCommentForTypeAssertionRule
  }
};
export default antiSlopPlugin;
