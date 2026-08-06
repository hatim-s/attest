# Trace Schema — `attest.trace/v1alpha1`

The open trace format attest uses for agent-native evaluation: trajectory assertions, tool-call checks, and trace visualization. Emit it from any language — it is plain JSON, aligned with OpenTelemetry GenAI semantic conventions where semantics match, but versioned independently so agent authors are insulated from upstream churn.

A trace is **optional**. Without one, attest still evaluates outputs; with one, trajectory metrics and the trace waterfall unlock.

## Document

```json
{
  "schema": "attest.trace/v1alpha1",
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
| `schema`   | string | yes      | Exactly `attest.trace/v1alpha1`.                                             |
| `trace_id` | string | yes      | Unique per invocation. Any stable string; ULID recommended.                  |
| `spans`    | array  | yes      | May be empty. Order is not significant; time and parentage define structure. |

### Span

| Field                    | Type           | Required | Notes                                                                                 |
| ------------------------ | -------------- | -------- | ------------------------------------------------------------------------------------- |
| `span_id`                | string         | yes      | Unique within the trace.                                                              |
| `parent_span_id`         | string \| null | yes      | `null` for roots. Multiple roots allowed.                                             |
| `name`                   | string         | yes      | Human-readable operation name.                                                        |
| `kind`                   | string         | yes      | `agent` \| `llm` \| `tool` \| `retrieval` \| `other`.                                 |
| `start_time`, `end_time` | string         | yes      | RFC 3339 with sub-second precision, UTC (`Z`). `end_time >= start_time`.              |
| `status`                 | object         | yes      | `{ "code": "ok" \| "error", "message"?: string }`.                                    |
| `attributes`             | object         | no       | Flat map, dot-namespaced keys → string \| number \| boolean. See conventions.         |
| `events`                 | array          | no       | `{ "name": string, "time": RFC3339, "attributes"?: object }` — point-in-time markers. |
| `input`, `output`        | JSON           | no       | Structured payloads for the operation. May be truncated by the emitter.               |

## Attribute conventions

Reuse OTel GenAI names where the meaning is identical; attest-specific concepts live under `attest.*`.

| Attribute                                                  | Span kind | Meaning                                                                 |
| ---------------------------------------------------------- | --------- | ----------------------------------------------------------------------- |
| `gen_ai.operation.name`                                    | any       | Operation class (`chat`, `invoke_agent`, `execute_tool`, …).            |
| `gen_ai.request.model` / `gen_ai.response.model`           | llm       | Requested / actually-served model id.                                   |
| `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` | llm       | Token usage as numbers.                                                 |
| `gen_ai.tool.name`                                         | tool      | Tool being executed — **trajectory assertions match on this**.          |
| `gen_ai.tool.call.id`                                      | tool      | Provider call id, when available.                                       |
| `gen_ai.tool.call.arguments`                               | tool      | Tool arguments as a JSON **string** — trajectory arg matchers parse it. |
| `attest.step.index`                                        | any       | Ordinal of a planner/loop step, when the framework has one.             |

Unknown attributes are always legal and always preserved.

## Reader rules (what attest guarantees)

1. **Unknown fields are preserved**, stored, and round-tripped — never stripped.
2. **Submitted traces are immutable**: attest never rewrites the original document; normalization happens on read into an internal representation.
3. **Older versions up-convert**: when `v1alpha2`+ exists, readers accept every published prior version.
4. Validation failures degrade gracefully: a malformed trace disables trajectory metrics for that case (recorded as a trace error) but never fails the invocation by itself.

## Versioning policy

- Within `v1alpha1`: additive optional fields only; no removals, no meaning changes.
- Breaking changes bump the version (`v1alpha2`, …, `v1`); the `schema` field is the sole discriminator.
- Each attest release documents which OTel GenAI semconv snapshot the attribute mapping was checked against.

## Converters

`attest trace convert` (Phase 2) ingests OTLP/JSON exports and OTel GenAI spans into this envelope. Emitting natively is a ~30-line helper in most languages — see `examples/`.
