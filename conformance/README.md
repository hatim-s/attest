# Conformance fixtures

These fixtures pin the behavior of the public contract parsers in `@attest/contracts`. Each fixture
is one JSON file named `NN-kebab-description.json` with this envelope:

```json
{
  "description": "What behavior this fixture protects.",
  "expect": "valid | invalid | valid-with-warnings",
  "issue_paths": ["field.0.child"],
  "warning_codes": ["unknown_field"],
  "preserve_paths": ["vendor_field"],
  "input": {}
}
```

`issue_paths` applies to invalid fixtures. It lists parser diagnostic paths, in the parser's dotted
form, that must appear. The parser may report more. `warning_codes` applies to
`valid-with-warnings` fixtures and must match exactly. `preserve_paths` lists input paths whose
values must survive parsing unchanged.

Each directory under `fixtures/` maps to one parser:

- `agent-request`
- `agent-response`
- `trace`
- `metric-request`
- `metric-result`

To add a fixture, create the next numbered JSON file in the right directory and run
`bun run --cwd conformance test`. The test reads every JSON file on disk, so there is no registry to
update. A directory without a parser fails the run.

`src/_tests_/fixtures/fake-agents/` holds the CLI and HTTP test agents that executor and runtime
tests spawn.
