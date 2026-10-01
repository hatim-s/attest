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

| Field      | Type          | Presence | Meaning                                                 |
| ---------- | ------------- | -------- | ------------------------------------------------------- |
| `protocol` | string        | always   | Envelope version. Reject requests you don't understand. |
| `run_id`   | string (ULID) | always   | The evaluation run this invocation belongs to.          |
| `case_id`  | string        | always   | The test case being executed.                           |
| `input`    | JSON          | always   | The case input, copied from the case. Shape is yours.   |
| `params`   | object        | optional | The case's `params`, passed through unchanged.          |

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

| Field      | Type   | Presence     | Meaning                                                                                                                                           |
| ---------- | ------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocol` | string | always       | Must match the request protocol.                                                                                                                  |
| `output`   | JSON   | xor `error`  | The agent's final answer. A string or structured JSON. Metrics decide how to read it.                                                             |
| `error`    | object | xor `output` | `{ "message": string, "code"?: string }`. The agent understood the request but could not answer. This is a case failure, not an invocation error. |
| `trace`    | object | optional     | An [`attest.trace`](./trace-schema.md) document. Without it, trace-dependent assertions fail; output metrics still run.                           |
| `state`    | JSON   | optional     | Reserved for multi-turn runs. The parser accepts it and the runner ignores it.                                                                    |

Exactly one of `output` and `error` must be present. A response with `output` is a success. A response with `error` is an agent failure.

A malformed `trace` does not invalidate the response. The parser omits it from the normalized response
and reports an `invalid_trace` warning. The runner still evaluates metrics. Assertions that require
trace evidence fail because no valid trace is available; output assertions can still pass.

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
