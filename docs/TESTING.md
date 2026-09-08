# Testing

Tests live in a local `_tests/` directory beside the source module they exercise and use the
`*.test.ts` naming convention. Test-only fixtures and support code belong beneath that same
directory. Add tests only for meaningful behavior: public contracts, important edge cases, and
regressions. Do not add tests merely to mirror implementation details.

Required CI must be deterministic. Use fake clocks for time-dependent behavior; do not use real
timers. Tests must not make network requests, and required CI must never call a live LLM. Keep
fixtures small, readable, and checked in when behavior is shared across packages.

Packed CLI acceptance tests extract the workspace archives and copy their already-installed
production dependency closure into a temporary runtime. They preserve each dependency's resolved
version and keep all dependency links inside that runtime. They do not invoke a package manager
or depend on registry metadata caches. Run `bun install --frozen-lockfile` before the tests.
The separate `bun run release:check` command verifies an actual npm installation of the archives;
that release check requires registry access for external dependencies.

The CLI test cache includes the documentation, example files, and CI workflows read by its
acceptance tests, so changes to those inputs rerun the contract checks.

Conformance fixtures in `conformance/fixtures/<contract>/` are golden input-and-expected files
shared across packages. They protect conformance at the contract seam and should change only
with an intentional contract change. Use property tests for pure logic with combinatorial inputs,
such as assertion evaluation and diffing.

Browser acceptance is required for dashboard behavior that cannot be established by unit tests.
Keep required CI deterministic and use the repository's available browser tooling for focused
local validation until an automated browser suite is added.
