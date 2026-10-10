# Anti-slop source

Source: https://github.com/dmmulroy/anti-slop
Commit: c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b

The 18 generic rules, shared helpers, and ESLint Stylistic vendor files are
ported from `src/` to `tools/anti-slop/`. Both MIT licenses are preserved.

Local changes:
- TypeScript is emitted as readable ESM JavaScript for direct Node/ESLint loading.
- Oxlint `defineRule` and `eslintCompatPlugin` wrappers are removed.
- `createOnce` becomes ESLint `create`, allocating state per file.
- Oxlint byte offsets become ESLint `range` offsets.
- The flat config enables every generic rule at error severity and ignores
  the vendored plugin and agent tooling.

Effect rules are not enabled because these projects do not directly depend on Effect.
Oxlint's native `oxc/no-accumulating-spread` is not part of this ESLint plugin.
Existing source findings are fixed as part of this lint adoption.

Validation: all 18 upstream generic RuleTester suites pass under ESLint 9.39.5
and TypeScript ESLint 8.66.0 after adapting their runner and parser.

The adapted upstream suites are in `_tests_/`. Run them with
`node tools/anti-slop/_tests_/run.mjs`. They also pass under ESLint 10.8.1.

Boundary predicates and assertion functions may use runtime `typeof` via
the upstream `allowInTypeGuards: true` option. Ad hoc narrowing remains an error.

## Documented boundary validators

Local option `allowDocumentedBoundaries: true` is enabled for unknown parameters,
unknown dictionary values, and runtime `typeof` checks. A directly attached
`BOUNDARY: <external source and checked contract>` comment identifies the owning
function, type alias, interface, or variable declaration. It does not propagate
into nested callbacks/declarations, and a file-level comment grants no exemption.
`any`, `object`, empty-object dictionaries, and unknown return values remain strict.
Only annotate real untrusted-input validation. Internal application data keeps
named domain types. Boundary comments are reviewed alongside parser tests.
