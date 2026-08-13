# Managed CLI and JSONL process integrations

Use a foreground native CLI for isolated cases, a JSONL bridge for one persistent correlated process per eval run, or a background CLI when a run-scoped local HTTP service is the natural boundary.

## Copy-paste example

```sh
mkdir attest-jsonl-guide && cd attest-jsonl-guide
cat > bridge.mjs <<'EOF'
import { createInterface } from 'node:readline';

/** Writes one complete protocol frame and nothing else to stdout. */
const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (line.trim() === '') continue;
  const frame = JSON.parse(line);
  if (frame.type === 'cancel') {
    send({ type: 'cancelled', request_id: frame.request_id });
    continue;
  }
  send({
    type: 'response',
    request_id: frame.request_id,
    response: { protocol: 'attest.agent-invocation', output: frame.request.input }
  });
}
EOF

attest project init . --name jsonl-guide --non-interactive --output json
attest agent add jsonl-echo \
  --jsonl-command 'node ./bridge.mjs' \
  --bridge-concurrency serial \
  --cancel-grace 1s \
  --timeout 30s \
  --output json
attest agent test jsonl-echo --input '"hello"' --output json
```

## Prerequisites

- `attest` on `PATH` and Node.js 22 or newer for this example.
- A trusted executable whose argv and working directory can be declared without a shell.
- For multiplexed mode, a bridge that can keep multiple request ids in flight and reply out of order.

## Expected files

```text
attest-jsonl-guide/
├── bridge.mjs
├── attest.project.json
└── attest/agents/jsonl-echo.json
```

The generated transport has `kind: "jsonl_bridge"`, `lifecycle: "per_run"`, `concurrency: "serial"`, and `cancellation_grace_ms: 1000`.

## Expected stdout

The final `attest.cli-result` document has `ok: true`, `command: "agent.test"`, `result.transport: "jsonl_bridge"`, and `result.response.output: "hello"`.

The bridge itself writes one JSON object per line to stdout. Its logs must go to stderr.

## Cleanup

```sh
cd ..
rm -rf ./attest-jsonl-guide
```

## JSONL bridge protocol

Attest sends one of these input frames per line:

```json
{
  "type": "request",
  "request_id": "req-…",
  "request": {
    "protocol": "attest.agent-invocation",
    "run_id": "…",
    "case_id": "…",
    "input": "hello"
  }
}
```

```json
{ "type": "cancel", "request_id": "req-…" }
```

Reply with the same `request_id`:

```json
{
  "type": "response",
  "request_id": "req-…",
  "response": { "protocol": "attest.agent-invocation", "output": "hello" }
}
```

```json
{ "type": "cancelled", "request_id": "req-…" }
```

Blank lines are ignored. Every other stdout line must be valid JSON and match the protocol. Unknown, missing, or duplicate request ids fail the session. EOF fails outstanding requests.

Choose `--bridge-concurrency serial` unless the bridge deliberately supports correlation under concurrency. In `multiplexed` mode responses may arrive out of order. Attest generates the request ids; the bridge must treat them as opaque.

## Cancellation and shutdown

On case timeout or cancellation, Attest sends the in-band `cancel` frame and waits `--cancel-grace`. A bridge should stop the corresponding work and answer `cancelled` promptly. If it does not settle in-band cancellation, Attest fails the session and terminates the process tree as the fallback. Closing the eval run always closes the run-scoped process.

Use `--timeout` to bound an individual request. A complete `attest.agent` JSON import can additionally set `timeouts.run_ms` and evidence limits when the run-scoped defaults need tightening.

## Background CLI service

For a process that exposes a local HTTP API, configure one readiness probe and one invocation URL:

```sh
attest agent add local-service \
  --background-command 'node ./server.mjs' \
  --readiness-http http://127.0.0.1:8787/ready \
  --invoke-url http://127.0.0.1:8787/invoke \
  --shutdown-url http://127.0.0.1:8787/shutdown \
  --response-pointer /output \
  --stop-timeout 5s \
  --timeout 30s \
  --output json
```

Exactly one readiness mode is allowed: repeat the command with either `--readiness-http URL`, `--readiness-tcp HOST:PORT`, or `--readiness-stderr REGEX`. Background readiness, invoke, and shutdown endpoints must be credential-free loopback HTTP(S); TCP readiness must also use loopback. Attest waits for readiness, invokes the service with the native request at `{{request}}`, attempts optional graceful shutdown, then enforces process-tree cleanup.

## Security and redaction

- Commands are tokenized to argv and executed directly. Pipes, redirects, globbing, and shell expansion do not run.
- `--cwd` must remain inside the project. Use repeatable `--env TARGET=SOURCE_ENV`; Attest stores references and resolves them only at invocation.
- Do not emit secrets or logs on stdout. Stderr is retained only as bounded diagnostic evidence and resolved secret values are redacted.
- A background service is intentionally restricted to loopback so this mode cannot become a general network pivot.
- Apply finite request, response, event-count, event-size, and total-evidence limits in an imported resource for untrusted peer output.

## Testing and stable errors

Run `attest agent test ID --input JSON --output json` before evaluation. JSONL protocol failures become top-level `invocation_failed`, exit `4`, with `details.invocation_code: "invalid_envelope"`. Spawn and exit failures use `spawn_failed` or `nonzero_exit`; deadlines use `timeout`. Ctrl-C uses top-level `cancelled` and exit `130`.

```sh
attest help agent add --output json
attest errors --output json
```
