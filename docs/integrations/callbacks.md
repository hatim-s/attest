# Callback integrations

Use the callback transport when one agent turn takes longer than an HTTP request should stay open.
Attest sends the request envelope to your trigger URL, your service answers `202` right away, and
later it posts an `attest.agent-completion` back to the callback URL attest gave it. The
completion can carry the output, a trace and the files the agent wrote.

## Copy-paste example

The agent below is a stand-in: it accepts the trigger, waits one second, and posts a completion
with one inline file and one file attest must fetch.

```sh
mkdir attest-callback-guide && cd attest-callback-guide
cat > agent-server.mjs <<'EOF'
import { createServer } from 'node:http';

const server = createServer(async (request, response) => {
  if (request.url === '/artifacts/notes-1') {
    response.writeHead(200, { 'content-type': 'text/markdown' }).end('# Notes\n');
    return;
  }

  let body = '';
  for await (const chunk of request) body += chunk;
  const invocation = JSON.parse(body);
  response.writeHead(202).end();

  setTimeout(async () => {
    await fetch(invocation.callback.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${invocation.callback.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        protocol: 'attest.agent-completion',
        run_id: invocation.run_id,
        case_id: invocation.case_id,
        output: 'Wrote src/answer.ts',
        artifacts: [
          {
            kind: 'inline',
            path: 'src/answer.ts',
            media_type: 'text/typescript',
            encoding: 'utf8',
            content: 'export const answer = 42;\n',
          },
          { kind: 'reference', path: 'notes.md', id: 'notes-1' },
        ],
      }),
    });
  }, 1000);
});

server.listen(8790, '127.0.0.1');
EOF

cat > agent.json <<'EOF'
{
  "schema": "attest.agent",
  "id": "async-coder",
  "name": "Async coder",
  "transport": {
    "kind": "callback",
    "lifecycle": "external",
    "trigger": { "url": "http://127.0.0.1:8790/runs", "method": "POST" },
    "idempotency_header": "Idempotency-Key",
    "artifact_fetch": { "url": "http://127.0.0.1:8790/artifacts/{{artifact_id}}", "method": "GET" }
  },
  "timeouts": { "attempt_ms": 600000 },
  "retry": { "retries": 2, "backoff": { "kind": "none" } }
}
EOF

attest project init . --name callback-guide --non-interactive --output json
attest agent import ./agent.json --type json --as async-coder --output json
node agent-server.mjs &
attest agent test async-coder --input '"write answer.ts"' --output json
kill %1
```

## Author a callback agent from flags

The same transport can be authored with `agent add`. These flags write the trigger, idempotency
header, and artifact fetch template from the JSON example above:

```sh
attest agent add async-coder \
  --callback-trigger-url http://127.0.0.1:8790/runs \
  --callback-trigger-method POST \
  --idempotency-header Idempotency-Key \
  --callback-artifact-url http://127.0.0.1:8790/artifacts/{{artifact_id}} \
  --timeout 10m --output json
```

Use `--callback-trace-url` for a `{{trace_ref}}` GET template, and `--callback-port` or
`--callback-public-url` to configure the receiver. Trigger headers and query values use repeatable
`--header NAME=VALUE`, `--header-env NAME=SOURCE_ENV`, and `--query NAME=VALUE` options. Callback
authoring also has a matching `agent.add` request shape for `--from-json`.

## Prerequisites

- `attest` and Node 22 or later on `PATH`.
- An agent service that can answer the trigger and make an outbound `POST` to the callback URL.
- When the agent runs on another machine, a URL it can reach for attest's receiver. Set
  `receiver.public_url` to it (a tunnel or reverse proxy in front of `receiver.listen_port`).

## Expected files

```text
attest-callback-guide/
├── agent-server.mjs
├── agent.json
├── attest.project.json
└── attest/agents/
    └── async-coder.json
```

`attest agent test` does not create `.attest/runs.db` unless you pass `--record`.

## Expected stdout

The import emits one `attest.cli-result` with `command: "agent.import"`. The probe emits a result
whose `transport` is `callback`, whose single attempt has `status: "ok"` and
`diagnostics.httpStatus: 202`, and whose `response.artifacts` holds both files inline. The
`notes.md` entry was fetched from `/artifacts/notes-1`, with `media_type` taken from the response's
`content-type`.

## Cleanup

```sh
cd ..
rm -rf ./attest-callback-guide
```

## Contract

The [agent contract](../specs/agent-contract.md#callback-transport) defines the transport and the
completion envelope. In short:

1. Attest registers a callback for the case, then sends the request envelope plus
   `callback: { "url", "token" }` to `trigger`. Any `2xx` is accepted. A `3xx` or `4xx` ends the
   case as an `http_status` invocation error. A `5xx`, `408` or `429` is retried within
   `retry.retries`, but only when `idempotency_header` is set: attest then sends the same
   SHA-256 key of the run and case ids on every try, so your service can drop a duplicate.
2. Your service posts the completion to `callback.url` with `Authorization: Bearer <token>` and
   `Content-Type: application/json`. The receiver answers:

   | Status | Meaning                                                                |
   | ------ | ---------------------------------------------------------------------- |
   | `202`  | Accepted. The body is `{ "accepted": true }`.                          |
   | `400`  | Malformed JSON, not a valid completion, or `run_id`/`case_id` mismatch |
   | `401`  | Wrong or missing bearer token.                                         |
   | `404`  | No case is waiting at this path, for example after a timeout.          |
   | `409`  | A completion for this case was already accepted.                       |
   | `413`  | The body is larger than `limits.response_bytes` (default 10 MiB).      |
   | `415`  | The content type is not `application/json`.                            |

   Retry a post on network errors and `5xx`. Do not retry `4xx`.

3. Attest fetches reference artifacts through `artifact_fetch` and a `trace_ref` through
   `trace_fetch`, enforces the artifact caps, and records an ordinary response envelope with
   inline artifacts only. Text that decodes as UTF-8 is stored with `encoding: "utf8"`; anything
   else is stored as base64.

Metrics then see the artifacts in the metric request. A command metric reads them as files under
`artifact_dir`; see the [metric contract](../specs/metric-contract.md).

## Security and limits

- The token is 32 random bytes, valid for one accepted completion, compared in constant time, and
  never logged. Attest hides it from stored evidence.
- The local receiver binds `127.0.0.1` only. It listens while at least one case is waiting and
  stops otherwise.
- The trigger carries the token and the agent sends it back to `receiver.public_url`, so both
  must use HTTPS unless they are loopback. The
  [network rules](./curl-and-http.md#security-and-redaction) for HTTP transports apply to the
  trigger and both fetch templates: no private address ranges, no cross-origin redirects, and
  `{{artifact_id}}` or `{{trace_ref}}` only in the path, query or headers.
- Use `{ "from_env": "NAME" }` references for credentials in any of the three templates.
- `limits.artifact_count` (default 64), `limits.artifact_bytes` (default 4 MiB) and
  `limits.total_artifact_bytes` (default 16 MiB) bound the artifacts. A fetched artifact over
  `artifact_bytes` stops downloading at the cap. Going over any cap is `output_cap_exceeded`; a
  repeated artifact path is `invalid_envelope`.

## Cancellation and stable errors

`timeouts.attempt_ms` (default 60 seconds) bounds the whole case: trigger, the wait for the
completion, and the fetches. Raise it for long agent turns. When it passes the case is a `timeout`
invocation error; Ctrl-C makes it `cancelled`. Either way the registration is released, so a late
post gets `404`. Attest cannot stop the remote work; your service should time out on its own.

See [Agent transport failures](../reference/errors.md#agent-transport-failures) for the
`details.invocation_code` values.
