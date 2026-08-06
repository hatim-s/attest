# Agent Contract — `attest.agent/v1alpha1`

How attest invokes your agent. Any language, any framework: expose either a **CLI command** or an **HTTP endpoint** that speaks this envelope, and attest can evaluate it.

## Model

attest treats your agent as a black box invoked once per test case (once per _turn_ in multi-turn simulation). The runner sends a **request envelope**, your agent returns a **response envelope** containing its final output and, optionally, a [trace](./trace-schema.md) of what it did internally. No SDK required.

## Request envelope

```json
{
  "protocol": "attest.agent/v1alpha1",
  "run_id": "01J9ZK7Q2M5X8W4V3T2R1QPN0M",
  "case_id": "greeting-basic",
  "input": { "question": "What is the capital of France?" },
  "params": { "locale": "en" },
  "messages": [{ "role": "user", "content": "What is the capital of France?" }],
  "turn_index": 0,
  "conversation_id": "01J9ZK7Q2M5X8W4V3T2R1QPN0M-greeting-basic-0"
}
```

| Field             | Type          | Presence        | Meaning                                                                                                      |
| ----------------- | ------------- | --------------- | ------------------------------------------------------------------------------------------------------------ |
| `protocol`        | string        | always          | Envelope version. Reject requests you don't understand.                                                      |
| `run_id`          | string (ULID) | always          | The evaluation run this invocation belongs to.                                                               |
| `case_id`         | string        | always          | The test case being executed.                                                                                |
| `input`           | JSON          | always          | The case input, verbatim from config. Shape is yours.                                                        |
| `params`          | object        | optional        | Case-level passthrough parameters from config.                                                               |
| `messages`        | array         | multi-turn only | Full conversation transcript so far (`{role, content}`; roles `user`/`assistant`). Single-turn runs omit it. |
| `turn_index`      | number        | multi-turn only | 0-based turn counter.                                                                                        |
| `conversation_id` | string        | multi-turn only | Stable id across turns of one simulated conversation.                                                        |

Multi-turn is **stateless by default**: each turn replays the full transcript, so your agent needs no session storage. HTTP agents may opt into stateful mode via the `state` token (below).

## Response envelope

```json
{
  "protocol": "attest.agent/v1alpha1",
  "output": "Paris is the capital of France.",
  "trace": { "schema": "attest.trace/v1alpha1", "trace_id": "…", "spans": [] }
}
```

| Field      | Type   | Presence                  | Meaning                                                                                                                                                                 |
| ---------- | ------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocol` | string | always                    | Must match the request protocol.                                                                                                                                        |
| `output`   | JSON   | xor `error`               | The agent's final answer. String or structured — metrics decide how to read it.                                                                                         |
| `error`    | object | xor `output`              | `{ "message": string, "code"?: string }` — the agent understood the request but failed to produce an answer. Counts as a **case failure**, not an infrastructure error. |
| `trace`    | object | optional                  | An [`attest.trace/v1alpha1`](./trace-schema.md) document. Omitting it disables trajectory metrics for this case; output metrics still run.                              |
| `state`    | JSON   | optional, HTTP multi-turn | Opaque token echoed back on the next turn's request as `state`.                                                                                                         |

Exactly one of `output` / `error` must be present — a response is either a **success** (`output`) or an **agent failure** (`error`), never both.

A malformed or invalid `trace` never invalidates the response: the output is still evaluated, trajectory metrics are disabled for the case, and the trace problem is reported as a warning diagnostic.

## CLI transport

The runner spawns your command once per invocation:

- **stdin**: the request envelope as a single JSON document.
- **stdout**: MUST be exactly one JSON response envelope. All logging goes to **stderr** (surfaced in reports, never parsed).
- **exit code**: `0` when a valid envelope was written (even if it contains `error`). Any other exit code is an **invocation error**.
- **cwd**: a fresh temporary directory per invocation. Do not rely on persistent local state.
- **environment**: the runner synthesizes `HOME` and `TMPDIR` beneath the per-attempt directory, inherits `PATH` after filtering it to absolute entries, and sets `LC_ALL=C` for a stable locale. Only variables allowlisted in config (`agent.env`) forward their real host values as explicit opt-in; those values override synthesized values. It also sets `ATTEST_RUN_ID`, `ATTEST_CASE_ID`, and `ATTEST_PROTOCOL`. Nothing else from the parent environment leaks through.

## HTTP transport

- `POST <agent.url>` with the request envelope as JSON body (`Content-Type: application/json`).
- `200` with a response envelope body = success (including agent-reported `error`).
- Redirects are not followed; any `3xx` is a terminal **invocation error**.
- Any other status, malformed body, or network failure is an **invocation error**. `5xx` and network failures are retried per config; `4xx` is not.
- Your endpoint must tolerate concurrent requests up to the run's configured concurrency.

## Execution semantics

| Concern     | Behavior                                                                                                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Timeout     | `agent.timeout_ms` per invocation (default 60 000). CLI: SIGTERM, 5 s grace, then SIGKILL using best-effort process-tree termination. HTTP: request aborted. Timeout = invocation error. |
| Retries     | `agent.retries` (default 0) applies to invocation errors only — never to agent-reported `error` envelopes.                                                                               |
| Output cap  | stdout / response body capped (default 10 MB). Exceeding the cap = invocation error.                                                                                                     |
| Concurrency | Cases run in parallel (`run.concurrency`). No ordering guarantees between cases.                                                                                                         |
| Determinism | The runner records request, response, timing, and exit metadata for every invocation, including retries.                                                                                 |

**Invocation error vs case failure**: invocation errors (spawn failure, timeout, bad envelope, non-zero exit, HTTP 5xx) mean attest could not evaluate the case and are reported as infrastructure problems. A well-formed `error` envelope or failing metric scores are results.

**Containment**: CLI process-tree termination is **best-effort**. Processes that daemonize into a new session after the pre-kill snapshot, and children spawned after that snapshot, can escape. Identity-checked signalling prevents PID-reuse kills, and unreaped survivors are reported in diagnostics.

## Versioning

`v1alpha1` may gain optional fields without notice; fields are never removed or repurposed within a version. Agents should ignore unknown request fields. Unknown top-level response fields are **preserved and surfaced as warnings** — never errors — so newer agents keep working against older attest versions.
