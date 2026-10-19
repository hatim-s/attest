# Agent contract: `attest.agent-invocation`

This page defines the JSON envelopes attest exchanges with an agent. An agent is a CLI command or an HTTP endpoint that reads a request envelope and returns a response envelope.

## Model

The runner invokes your agent once per test case. It sends a request envelope. Your agent returns a response envelope with its final output and, optionally, a [trace](./trace-schema.md) of its internal steps.

## Request envelope

```json
{
  "protocol": "attest.agent-invocation",
  "run_id": "01J9ZK7Q2M5X8W4V3T2R1QPN0M",
  "case_id": "greeting-basic",
  "input": { "question": "What is the capital of France?" },
  "params": { "locale": "en" }
}
```

| Field      | Type          | Presence | Meaning                                                     |
| ---------- | ------------- | -------- | ----------------------------------------------------------- |
| `protocol` | string        | always   | Envelope version. Reject requests you don't understand.     |
| `run_id`   | string (ULID) | always   | The evaluation run this invocation belongs to.              |
| `case_id`  | string        | always   | The test case being executed.                               |
| `input`    | JSON          | always   | The case input, copied from the case. Shape is yours.       |
| `params`   | object        | optional | The case's `params`, passed through unchanged.              |
| `callback` | object        | optional | Sent only by the [callback transport](#callback-transport). |

The schema also accepts `messages`, `turn_index`, `conversation_id`, and `state`. They are
reserved for multi-turn runs. The runner does not send them yet.

## Response envelope

```json
{
  "protocol": "attest.agent-invocation",
  "output": "Paris is the capital of France.",
  "trace": { "schema": "attest.trace", "trace_id": "…", "spans": [] }
}
```

| Field       | Type   | Presence     | Meaning                                                                                                                                           |
| ----------- | ------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocol`  | string | always       | Must match the request protocol.                                                                                                                  |
| `output`    | JSON   | xor `error`  | The agent's final answer. A string or structured JSON. Metrics decide how to read it.                                                             |
| `error`     | object | xor `output` | `{ "message": string, "code"?: string }`. The agent understood the request but could not answer. This is a case failure, not an invocation error. |
| `trace`     | object | optional     | An [`attest.trace`](./trace-schema.md) document. Without it, trace-dependent assertions fail; output metrics still run.                           |
| `state`     | JSON   | optional     | Reserved for multi-turn runs. The parser accepts it and the runner ignores it.                                                                    |
| `artifacts` | array  | optional     | Files the agent produced, each an [inline artifact](#artifacts). Metrics receive them.                                                            |

Exactly one of `output` and `error` must be present. A response with `output` is a success. A response with `error` is an agent failure.

A malformed `trace` does not invalidate the response. The parser omits it from the normalized response
and reports an `invalid_trace` warning. The runner still evaluates metrics. Assertions that require
trace evidence fail because no valid trace is available; output assertions can still pass.

## Artifacts

An artifact is a file the agent produced: generated code, an HTML page, a JSON report, an image.
Any transport may return artifacts in the response envelope. Attest stores them with the response
and passes them to executable metrics.

```json
{
  "kind": "inline",
  "path": "src/answer.ts",
  "media_type": "text/typescript",
  "encoding": "utf8",
  "content": "export const answer = 42;\n"
}
```

| Field        | Type   | Meaning                                                                      |
| ------------ | ------ | ---------------------------------------------------------------------------- |
| `kind`       | string | `inline` in a response. A completion may also send `reference` (see below).  |
| `path`       | string | Where the file goes, relative to the directory attest writes artifacts into. |
| `media_type` | string | 1 to 255 characters, such as `text/html` or `image/png`.                     |
| `encoding`   | string | `utf8` when `content` is the text itself, `base64` for bytes.                |
| `content`    | string | The file contents in that encoding.                                          |

A path is a canonical relative file path: segments joined by `/`, none of them empty, `.` or `..`.
Absolute paths, drive letters, backslashes, control characters and a trailing `/` are rejected,
because attest writes each artifact to `<dir>/<path>` and two spellings of one file would
overwrite each other.

## CLI transport

The runner spawns your command once per invocation:

- **stdin**: the request envelope as a single JSON document.
- **stdout**: MUST be exactly one JSON response envelope. All logging goes to **stderr** (surfaced in reports, never parsed).
- **exit code**: `0` when a valid envelope was written (even if it contains `error`). Any other exit code is an **invocation error**.
- **cwd**: a fresh temporary directory per invocation. Do not rely on persistent local state.
- **environment**: the runner synthesizes `HOME` and `TMPDIR` beneath the per-attempt directory, inherits `PATH` after filtering it to absolute entries, and sets `LC_ALL=C` for a stable locale. Variables listed in the agent's `transport.env` map forward their real values, and those values override the synthesized ones. It also sets `ATTEST_RUN_ID`, `ATTEST_CASE_ID`, and `ATTEST_PROTOCOL`. Nothing else from the parent environment leaks through.

## HTTP transport

- `POST` to `transport.request.url` with the request envelope as JSON body (`Content-Type: application/json`).
- `200` with a response envelope body = success (including agent-reported `error`).
- Redirects are not followed; any `3xx` is a terminal **invocation error**.
- Any other status, malformed body, or network failure is an **invocation error**. The runner retries `5xx` and network failures up to `retry.retries` times. It does not retry `4xx`.
- Your endpoint receives up to the run's concurrency limit of requests at once.

## Callback transport

The callback transport is for agents that run longer than one HTTP request. Attest triggers the
agent, lets the connection go, and waits for the agent to post a completion back.

```json
{
  "kind": "callback",
  "lifecycle": "external",
  "trigger": { "url": "https://agent.example.com/runs", "method": "POST" },
  "idempotency_header": "Idempotency-Key",
  "artifact_fetch": {
    "url": "https://agent.example.com/artifacts/{{artifact_id}}",
    "method": "GET"
  },
  "trace_fetch": { "url": "https://agent.example.com/traces/{{trace_ref}}", "method": "GET" },
  "receiver": { "listen_port": 0, "public_url": "https://attest.example.com" }
}
```

1. Attest sends the request envelope to `trigger` with one extra field,
   `callback: { "url": string, "token": string }`. `trigger.method` must be `POST` or `PUT`, and
   `trigger.body` must be omitted because the envelope is the body. Any `2xx` means the agent
   accepted the work.
2. The agent posts an `attest.agent-completion` to `callback.url` with the header
   `Authorization: Bearer <callback.token>`. The path is
   `/attest/completions/<run_id>/<case_id>`, and the token works once.
3. Attest fetches every reference artifact through `artifact_fetch` and a `trace_ref` through
   `trace_fetch`. Both templates must use `GET`. `{{artifact_id}}` and `{{trace_ref}}` are
   replaced with the values from the completion. The artifact fetch returns the file bytes. The
   trace fetch returns an `attest.trace` document.
4. The parser receives an ordinary response envelope with inline artifacts only. Other transports
   never see the completion shape.

`timeouts.attempt_ms` bounds the wait for the completion, exactly like polling. Attest cannot
cancel the remote work. `receiver.listen_port` picks the local listener port (`0`, the default,
picks a free one). `receiver.public_url` is the base URL the agent is told to post to; it defaults
to `http://127.0.0.1:<port>`. `limits.artifact_count`, `limits.artifact_bytes` and
`limits.total_artifact_bytes` cap the artifacts one completion may carry.

Local runs reject callback agents until the callback adapter ships.

### Completion envelope

```json
{
  "protocol": "attest.agent-completion",
  "run_id": "01J9ZK7Q2M5X8W4V3T2R1QPN0M",
  "case_id": "greeting-basic",
  "output": "Wrote src/answer.ts",
  "trace_ref": "trace-8812",
  "artifacts": [
    {
      "kind": "inline",
      "path": "src/answer.ts",
      "media_type": "text/typescript",
      "encoding": "utf8",
      "content": "export const answer = 42;\n"
    },
    { "kind": "reference", "path": "shots/home.png", "media_type": "image/png", "id": "blob-41" }
  ]
}
```

| Field       | Type          | Presence     | Meaning                                                              |
| ----------- | ------------- | ------------ | -------------------------------------------------------------------- |
| `protocol`  | string        | always       | `attest.agent-completion`.                                           |
| `run_id`    | string (ULID) | always       | Copied from the request.                                             |
| `case_id`   | string        | always       | Copied from the request.                                             |
| `output`    | JSON          | xor `error`  | Same as the response envelope.                                       |
| `error`     | object        | xor `output` | Same as the response envelope.                                       |
| `state`     | JSON          | optional     | Same as the response envelope.                                       |
| `trace`     | object        | optional     | An inline `attest.trace`. Not allowed together with `trace_ref`.     |
| `trace_ref` | string        | optional     | 1 to 256 characters. Attest fetches the trace through `trace_fetch`. |
| `artifacts` | array         | optional     | Inline artifacts or references.                                      |

A reference artifact is `{ "kind": "reference", "path", "id", "media_type"? }`. `id` is 1 to 256
characters and fills `{{artifact_id}}`. When `media_type` is absent, attest uses the fetch
response's `content-type`. Unlike the response envelope, the completion rejects unknown fields.

## Execution semantics

| Concern     | Behavior                                                                                                                                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Timeout     | `timeouts.attempt_ms` per invocation (default 60 000). A test's `defaults.timeout_ms` overrides it. CLI: SIGTERM, 5 s grace, then SIGKILL with best-effort process-tree termination. HTTP: the request is aborted. A timeout is an invocation error. |
| Retries     | `retry.retries` (default 0) applies to invocation errors only, never to agent-reported `error` envelopes.                                                                                                                                            |
| Output cap  | stdout and response bodies are capped (default 10 MB). Exceeding the cap is an invocation error.                                                                                                                                                     |
| Concurrency | Cases run in parallel up to `defaults.concurrency` in `attest.project.json`, a test's `defaults.concurrency`, or `attest eval run --concurrency`. Cases have no ordering guarantee.                                                                  |
| Evidence    | The runner records request, response, timing, and exit metadata for every invocation, including retries.                                                                                                                                             |

**Invocation error or case failure.** An invocation error (spawn failure, timeout, bad envelope, non-zero exit, HTTP 5xx) means attest could not evaluate the case. A well-formed `error` envelope or a failing metric score is a result.

**Containment.** CLI process-tree termination is best-effort. A process that daemonizes into a new session after the pre-kill snapshot can escape, and so can a child spawned after that snapshot. Before signalling, the runner compares each process's start time and command to reduce PID-reuse risk. Same-second reuse by the same command still matches, and a process can change between the check and the signal. Diagnostics list unreaped or unverified processes.

Unknown request fields are extensions. The parser keeps unknown top-level response fields and
reports each one as a warning.
