import { createRequire } from "node:module";
import { RuleTester } from "eslint";

const require = createRequire(import.meta.url);
let parser;
try {
  parser = require("typescript-eslint").parser;
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
  try {
    parser = require("@typescript-eslint/parser");
  } catch (parserError) {
    if (parserError.code !== "MODULE_NOT_FOUND") throw parserError;
    parser = createRequire(require.resolve("eslint-config-next"))("@typescript-eslint/parser");
  }
}

class AntiSlopRuleTester extends RuleTester {
  constructor() {
    super({ languageOptions: { parser, parserOptions: { ecmaVersion: 2022, sourceType: "module" } } });
  }
}

export { AntiSlopRuleTester as RuleTester };
