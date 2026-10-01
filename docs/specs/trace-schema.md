# Trace schema: `attest.trace`

An `attest.trace` document is plain JSON that lists the spans of one agent invocation. Trajectory
assertions, tool-call checks, and the dashboard's trace waterfall read it. Attribute names follow
the OpenTelemetry GenAI semantic conventions where the meaning matches.

A trace is optional. Without one, attest evaluates outputs and skips trajectory metrics.

## Document

```json
{
  "schema": "attest.trace",
  "trace_id": "01J9ZKA3F8Q2T7R6S5P4N3M2L1",
  "spans": [
    {
      "span_id": "s1",
      "parent_span_id": null,
      "name": "agent.run",
      "kind": "agent",
      "start_time": "2026-08-06T10:15:03.120Z",
      "end_time": "2026-08-06T10:15:09.480Z",
      "status": { "code": "ok" },
      "attributes": { "gen_ai.operation.name": "invoke_agent" }
    },
    {
      "span_id": "s2",
      "parent_span_id": "s1",
      "name": "llm.call",
      "kind": "llm",
      "start_time": "2026-08-06T10:15:03.250Z",
      "end_time": "2026-08-06T10:15:05.900Z",
      "status": { "code": "ok" },
      "attributes": {
        "gen_ai.request.model": "claude-sonnet-5",
        "gen_ai.usage.input_tokens": 812,
        "gen_ai.usage.output_tokens": 96
      },
      "input": { "messages": [] },
      "output": { "content": "…" }
    },
    {
      "span_id": "s3",
      "parent_span_id": "s1",
      "name": "tool.search",
      "kind": "tool",
      "start_time": "2026-08-06T10:15:06.010Z",
      "end_time": "2026-08-06T10:15:06.900Z",
      "status": { "code": "error", "message": "upstream 503" },
      "attributes": {
        "gen_ai.tool.name": "search",
        "gen_ai.tool.call.id": "call_1",
        "gen_ai.tool.call.arguments": "{\"query\":\"capital of France\"}"
      }
    }
  ]
}
```

## Fields

### Document

| Field      | Type   | Required | Notes                                                                        |
| ---------- | ------ | -------- | ---------------------------------------------------------------------------- |
| `schema`   | string | yes      | Exactly `attest.trace`.                                                      |
| `trace_id` | string | yes      | Unique per invocation. Any stable string; ULID recommended.                  |
| `spans`    | array  | yes      | May be empty. Order is not significant; time and parentage define structure. |

### Span

| Field                    | Type           | Required | Notes                                                                                |
| ------------------------ | -------------- | -------- | ------------------------------------------------------------------------------------ |
| `span_id`                | string         | yes      | Unique within the trace.                                                             |
| `parent_span_id`         | string \| null | yes      | `null` for roots. Multiple roots allowed.                                            |
| `name`                   | string         | yes      | Human-readable operation name.                                                       |
| `kind`                   | string         | yes      | `agent` \| `llm` \| `tool` \| `retrieval` \| `other`.                                |
| `start_time`, `end_time` | string         | yes      | RFC 3339 UTC (`Z`); sub-second precision recommended. `end_time >= start_time`.      |
| `status`                 | object         | yes      | `{ "code": "ok" \| "error", "message"?: string }`.                                   |
| `attributes`             | object         | no       | Flat map, dot-namespaced keys → string \| number \| boolean. See conventions.        |
| `events`                 | array          | no       | Point-in-time markers: `{ "name": string, "time": RFC3339, "attributes"?: object }`. |
| `input`, `output`        | JSON           | no       | Structured payloads for the operation. May be truncated by the emitter.              |

## Attribute conventions

Reuse OTel GenAI names where the meaning is identical; attest-specific concepts live under `attest.*`.

| Attribute                                                  | Span kind | Meaning                                                      |
| ---------------------------------------------------------- | --------- | ------------------------------------------------------------ |
| `gen_ai.operation.name`                                    | any       | Operation class (`chat`, `invoke_agent`, `execute_tool`, …). |
| `gen_ai.request.model` / `gen_ai.response.model`           | llm       | Requested / actually-served model id.                        |
| `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` | llm       | Token usage as numbers.                                      |
| `gen_ai.tool.name`                                         | tool      | Tool name. Trajectory assertions match on this.              |
| `gen_ai.tool.call.id`                                      | tool      | Provider call id, when available.                            |
| `gen_ai.tool.call.arguments`                               | tool      | Tool arguments as a JSON string. Argument matchers parse it. |

Unknown attributes are allowed and preserved.

## Reader rules

1. Unknown fields are stored and returned unchanged.
2. Attest never rewrites a submitted trace. It normalizes a copy when reading.
3. A malformed trace disables trajectory metrics for that case and is recorded as a trace error. It does not fail the invocation.

## Converters

`attest trace convert export.json` reads an OTLP/HTTP JSON export and prints this envelope. It
groups spans by the OTLP hexadecimal `traceId`. Pass `--trace-id` when an export contains more than
one trace, and `--output trace.json` to write a file. The command refuses to overwrite an existing
file and fails with `output_exists`. Pass `--force` to replace it. Scalar resource, scope, and span attributes are
preserved. Stable aliases normalize Vercel AI SDK and LangSmith tool/model/token attributes into the
`gen_ai.*` names used by trajectory assertions. Agents can also write the envelope directly.
