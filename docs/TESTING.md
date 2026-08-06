# Testing

Tests live next to the source they exercise and use the `*.test.ts` naming convention. Add tests
only for meaningful behavior: public contracts, important edge cases, and regressions. Do not add
tests merely to mirror implementation details.

Required CI must be deterministic. Use fake clocks for time-dependent behavior; do not use real
timers. Tests must not make network requests, and required CI must never call a live LLM. Keep
fixtures small, readable, and checked in when behavior is shared across packages.

Conformance fixtures in `conformance/fixtures/<contract>/` are golden input-and-expected files
shared across packages. They protect compatibility at the contract boundary and should change only
with an intentional contract change. Use property tests for pure logic with combinatorial inputs,
such as assertion evaluation and diffing.

Playwright arrives in Phase 2 for dashboard flows. Until then, browser testing is outside this
scaffold's required CI.
