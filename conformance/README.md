# Conformance fixtures

These fixtures are the cross-package compatibility gate for public attest contracts. Each fixture
is one JSON file named `NN-kebab-description.json` and has this envelope:

```json
{
  "description": "What behavior this fixture protects.",
  "expect": "valid | invalid | valid-with-warnings",
  "issue_paths": [["field", "0", "child"]],
  "warning_codes": ["unknown_field"],
  "input": {}
}
```

`issue_paths` is used only for invalid fixtures. It lists the exact parser diagnostic paths that
must be present; a fixture may intentionally require only a subset of all diagnostics. `warning_codes`
is used only for `valid-with-warnings` fixtures and must match exactly.

Fixtures live in six directories, each routed to its matching public parser:

- `agent-request`
- `agent-response`
- `config`
- `trace`
- `metric-request`
- `metric-result`

To add a fixture, choose the contract directory, create the next numbered JSON file with the
envelope above, and run the conformance test. The synchronous directory loader automatically finds
new JSON fixtures, so no registry needs updating. `fake-agents/` holds hostile agent executables
used to harden the runner.
