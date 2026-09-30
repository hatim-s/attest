# Testing

Tests live in a local `_tests_/` directory beside the source module they exercise and use the
`*.test.ts` naming convention. Test-only fixtures and support code belong beneath that same
directory. Add tests only for meaningful behavior: public contracts, important edge cases, and
regressions. Do not add tests merely to mirror implementation details.

Required CI must be deterministic. Use fake clocks for time-dependent behavior; do not use real
timers. Tests must not make network requests, and required CI must never call a live LLM. Keep
fixtures small, readable, and checked in when behavior is shared across packages.

Conformance fixtures in `conformance/fixtures/<contract>/` are golden input-and-expected files
shared across packages. They protect conformance at the contract seam and should change only
with an intentional contract change. Use property tests for pure logic with combinatorial inputs,
such as assertion evaluation and diffing.
