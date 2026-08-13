# Agents

## Copy-paste example

Create a native agent, prove its envelope, and keep the probe out of the run store:

```sh
cat > agent.mjs <<'EOF'
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
process.stdout.write(JSON.stringify({
  protocol: 'attest.agent-invocation',
  output: request.input,
}));
EOF

attest project init . --name support --non-interactive --output json
attest agent add support --argv-json '["node","./agent.mjs"]' --timeout 5s --output json
attest agent test support --input '"ping"' --output json
```

## Prerequisites

- Attest is installed and `attest help agent add --output json` succeeds.
- Node.js 22 or newer is available for the example agent.
- Run the commands from an empty directory. An existing project may omit `project init`.

## Expected files

`project init` writes `attest.project.json`. `agent add` writes
`attest/agents/support.json` and updates the manifest content hash. `agent test` writes nothing
unless `--record` is present. None of the three commands creates `attest.config.json`.

## Expected stdout

Each command using `--output json` prints exactly one `attest.cli-result` document. Success has
`ok: true`, a dotted `command`, project hashes, a `result`, and `warnings`. For the probe, the
command is `agent.test` and the result contains the normalized agent response. Do not scrape human
sentences; select fields from the JSON document.

## Cleanup

```sh
rm -f agent.mjs attest/agents/support.json attest.project.json
rmdir attest/agents attest 2>/dev/null || true
```

## Interactive authoring

`attest agent add` is a wizard only when stdin and stdout are TTYs, output is `human`, CI is not
detected, `--non-interactive` is absent, and `--from-json` is absent. It asks for an id and one
transport: `cli` (the default), `http`, `background`, `jsonl`, `stream`, or `websocket`. Transport
questions have working defaults where the contract defines them. The CLI then shows the semantic
operations and a redacted definition preview; `Apply these changes? [y/N]` defaults to no.

`--yes` accepts the confirmation but never invents a missing id, command, URL, mapping, or secret
reference. `--dry-run` returns the same semantic diff without a lock, journal, or file write.

## Non-interactive and JSON flows

`--output json` implies non-interactive behavior. Missing required input is
`cli_missing_input` (exit 2), and overlapping flags or an invalid value are `cli_usage` (exit 2).
For scripts, prefer unambiguous `--argv-json` over the convenience tokenizer in
`--native-command`.

```sh
PROJECT_HASH=$(attest project show --output json | jq -r '.project_hash_after')
attest agent add support-renamed \
  --argv-json '["node","./agent.mjs"]' \
  --timeout 5s \
  --if-project-hash "$PROJECT_HASH" \
  --output json
```

All authoring mutations accept one complete `attest.command-request` document from a file or
stdin:

```sh
attest agent add --from-json ./agent-add.json --output json
attest agent import --from-json ./agent-import.json --output json
```

`--from-json -` consumes stdin. It conflicts with positional authoring values, mutation flags, and
transport flags; the request must carry the entire command. Discover the exact branch before
constructing it:

```sh
attest help agent add --output json
attest schema print attest.command-request --output json
```

## Transport entry points

Only one transport selector may be supplied to `agent add`:

| Transport | Entry point | Essential contract |
| --- | --- | --- |
| Native process | `--argv-json` or `--native-command` | One process per case; stdin request and stdout response use `attest.agent-invocation`. |
| Native HTTP | `--native-http` | External POST endpoint using the native envelope. |
| Managed process | `--background-command` | Run-scoped process plus exactly one readiness method and `--invoke-url`. |
| JSONL bridge | `--jsonl-command` | Run-scoped, correlated lines; serial or multiplexed; in-band cancellation with process fallback. |
| HTTP stream | `--stream-url` | External SSE or JSONL stream with terminal and extraction pointers. |
| WebSocket | `--websocket-url` | Plain `ws://` or `wss://` text JSON; per-case or per-run lifecycle. |

Use `attest help agent add --output json` for the current options, conflicts, implied flags, choices,
examples, and request schema. Environment mappings such as `--env TARGET=SOURCE_ENV` and
`--header-env Authorization=AGENT_TOKEN` persist only the source environment-variable name.

## Import JSON or cURL

Canonical JSON may come from a local file, stdin, or a bounded HTTP(S) URL:

```sh
attest agent import ./agent.json --type json --as support --output json
attest agent import - --type json --as support --output json
```

cURL import accepts a local UTF-8 file or stdin. It parses the request as data; it does not invoke a
shell. Map captured inputs and credentials explicitly:

```sh
attest agent import ./request.curl \
  --type curl \
  --as support-http \
  --map-body /prompt=/question \
  --header-env Authorization=AGENT_TOKEN \
  --response-pointer /answer \
  --dry-run
```

The interactive cURL flow discovers header and query credential names without echoing their
values, asks for environment bindings, body mappings, response/error/trace pointers, and either a
direct or polling transport. Polling requires a job-id pointer, exactly one status-URL pointer or
same-origin `{{job_id}}` template, a status pointer, terminal success/failure values, and bounded
intervals. Unsupported cURL flags, embedded URL credentials, redirects, unsafe file bodies, and
unmapped secret literals fail before any project write.

Useful cURL entry points are:

```sh
attest help agent import --output json
attest agent import ./request.curl --type curl --as support-http --dry-run
attest agent import ./request.curl --type curl --as support-http --yes --output json
```

Review the redacted dry run before the final command. A JSON result can expose normalized mapping
metadata, never the captured secret value or raw request source.

## Test, record, rename, and remove

Probe with an inline JSON value, a file, stdin, or a complete command request:

```sh
attest agent test support --input '{"question":"ping"}' --output json
attest agent test support --input-file ./input.json --output json
attest agent test support --input-file - --output json
attest agent test --from-json ./agent-test.json --output json
```

`--watch` is human-only. `--record` creates `.attest/runs.db`; an ordinary probe does not. Rename
updates every test reference atomically. Removal is blocked while tests reference the agent unless
`--detach` explicitly removes those dependent tests:

```sh
attest agent rename support support-renamed --dry-run
attest agent remove support-renamed --dry-run
attest agent remove support-renamed --detach --yes --output json
```

## Agent-readable contract

1. Call `attest help agent <verb> --output json` and read `result.command`.
2. Treat `usage`, `arguments`, `options`, `conflicts`, `implies`, `choices`, `request_schema`, and
   `examples` as data.
3. Use one input route: flags/arguments or `--from-json`, never both.
4. Preview mutations with `--dry-run`; bind the returned project hash with `--if-project-hash` on
   the eventual write.
5. Parse one `attest.cli-result` document from stdout and branch on `ok`. On failure, use
   `error.code`, `retryable`, `path`, `hint`, and `details`; do not match message text.
6. List stable repairs with `attest errors --output json` or see [Errors](../reference/errors.md).

Related contracts: [Schemas](../reference/schemas.md), [Exit codes](../reference/exit-codes.md),
and [File layout](../reference/file-layout.md).
