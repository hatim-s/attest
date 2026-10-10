import { RuleTester } from "./runtime.mjs";
import { noUnknownParametersRule } from "../rules/no-unknown-parameters.mjs";
import { noUnsafeDictionaryTypeRule } from "../rules/no-unsafe-dictionary-type.mjs";
import { noRuntimeTypeofRule } from "../rules/no-runtime-typeof.mjs";

const options = [{ allowDocumentedBoundaries: true }];
const tester = new RuleTester();

tester.run("documented unknown-input boundaries", noUnknownParametersRule, {
  valid: [
    { code: "// BOUNDARY: HTTP JSON is validated against the request schema.\nexport function parse(input: unknown): string { return String(input); }", options },
    { code: "/** BOUNDARY: Storage input is checked against the session schema. */\nconst parse = (input: unknown): string => String(input);", options },
  ],
  invalid: [
    { code: "function consume(input: unknown) {}", options, errors: [{ messageId: "unknownParameter" }] },
    { code: "// BOUNDARY:\nfunction parse(input: unknown) {}", options, errors: [{ messageId: "unknownParameter" }] },
    { code: "// BOUNDARY: HTTP JSON.\n\nfunction parse(input: unknown) {}", options, errors: [{ messageId: "unknownParameter" }] },
    { code: "// BOUNDARY: HTTP JSON.\nfunction parse(input: unknown) { function consume(value: unknown) {} }", options, errors: [{ messageId: "unknownParameter" }] },
    { code: "// BOUNDARY: HTTP JSON.\nfunction parse(input: unknown) {}", errors: [{ messageId: "unknownParameter" }] },
  ],
});

tester.run("documented raw dictionary boundaries", noUnsafeDictionaryTypeRule, {
  valid: [{ code: "// BOUNDARY: Raw HTTP object members are inspected before domain conversion.\nexport type RawRequest = Record<string, unknown>;", options }],
  invalid: [
    { code: "type ApplicationData = Record<string, unknown>;", options, errors: [{ messageId: "unsafeDictionary" }] },
    { code: "// BOUNDARY: Raw HTTP members.\ntype RawRequest = Record<string, any>;", options, errors: [{ messageId: "unsafeDictionary" }] },
    { code: "// BOUNDARY: Raw HTTP members.\ntype RawRequest = Record<string, object>;", options, errors: [{ messageId: "unsafeDictionary" }] },
  ],
});

tester.run("documented representation validation", noRuntimeTypeofRule, {
  valid: [{ code: "// BOUNDARY: Webhook JSON is checked for its string identifier.\nfunction parse(input) { return typeof input === 'string'; }", options }],
  invalid: [
    { code: "function internal(value) { return typeof value === 'string'; }", options, errors: [{ messageId: "runtimeTypeof" }] },
    { code: "// BOUNDARY: HTTP JSON.\nfunction parse(input) { return () => typeof input === 'string'; }", options, errors: [{ messageId: "runtimeTypeof" }] },
  ],
});
