# Metric contract: `attest.metric-evaluation`

A metric resource in `attest/metrics/<id>.json` has a `definition.kind` of `assertion`, `judge`,
`exec`, or `http`. Every kind produces the same result shape, so reports and diffs read them the
same way. The [metric guide](../cli/metrics.md) owns authoring commands and presets.

## Result shape

```json
{
  "score": 1,
  "pass": true,
  "rationale": "Answer names Paris and cites the expected source.",
  "details": { "matched": ["$.output"] }
}
```

| Field       | Type    | Required | Notes                                                    |
| ----------- | ------- | -------- | -------------------------------------------------------- |
| `score`     | number  | yes      | Usually 0 to 1. Any finite number is allowed.            |
| `pass`      | boolean | yes      | The verdict used by diffs and exit codes.                |
| `rationale` | string  | no       | Human-readable justification. Judges always set it.      |
| `details`   | JSON    | no       | Structured evidence such as matched paths or sub-scores. |

## Assertions (`kind: assertion`)

Assertions run in-process. A metric holds a non-empty list of checks. It passes when every check
holds, and its score is the fraction of checks that passed.

Paths start at `$`, the evaluation document `{ input, output, expected, trace }`. They support dot
fields and `[n]` indexes only. Wildcards, filters, and recursive descent are rejected.

The checks are `equals`, `contains` (string or array containment), `regex`, `json_schema`
(Draft 2020-12), `threshold` (`lt`, `lte`, `gt`, `gte` on numbers), `exists`, `tool_calls`,
`spans`, and the combinators `all`, `any`, and `not`. `regex` takes `{ path, pattern, flags? }` in
JavaScript `RegExp` syntax, so inline modifiers such as `(?i)` are invalid. Use `"flags": "i"`.
A `regex` target longer than 64 KiB fails the check without running the pattern. Combinator
arrays, argument matcher arrays, and the assertion list must be non-empty.

`tool_calls.name` matches the `gen_ai.tool.name` attribute, falling back to the span name. `status`
and exact `count` apply to the matching calls. `order` compares their names chronologically.
`arguments` requires at least one matching call whose `gen_ai.tool.call.arguments` JSON satisfies
every `equals`, `contains`, and `exists` matcher. When that attribute is absent, the span's
structured `input` is used.

`spans.filter` selects by `kind`, span `name`, `status`, and a partial exact attribute map. A filter
alone requires at least one match. `count` and chronological `order` apply to the filtered spans.
Missing or malformed trace evidence fails the assertion. It does not raise a metric error.

## Judges (`kind: judge`)

A judge sends a rubric to an LLM. The model uses `provider/model` form, where the provider is
`anthropic` or `openai`. The provider SDK reads `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` from the
environment. Keys never appear in project files or run records.

`pass` is `score >= threshold`. `--threshold` defaults to 0.8.

- The judge sees `input`, `output`, `expected`, and a trace summary when a trace exists. It never
  sees other cases.
- The run records the full judge request (model, prompt, parameters) and the raw response.
- With a shared cache enabled, a recorded successful judge result is reused by the content hash
  of its request. Calls without a cache and failed provider calls do not produce reusable hits.
- Provider errors and unparseable responses are metric errors, distinct from `pass: false`.

## Executable metrics (`kind: exec` and `kind: http`)

Executable metrics run your scoring code. The runner sends this request body:

```json
{
  "protocol": "attest.metric-evaluation",
  "case": { "id": "greeting", "input": {}, "expected": {}, "params": {} },
  "output": "the agent's output",
  "trace": { "schema": "attest.trace", "trace_id": "trace-1", "spans": [] },
  "artifacts": [
    {
      "kind": "inline",
      "path": "src/answer.ts",
      "media_type": "text/typescript",
      "encoding": "utf8",
      "content": "export const answer = 42;\n"
    }
  ],
  "artifact_dir": "/tmp/attest-metric-Xc81qa"
}
```

`trace` is `null` when the agent returned none. Ignore unknown request fields.

`artifacts` holds the agent's [inline artifacts](./agent-contract.md#artifacts) and is `[]` when
there are none. `artifact_dir` is the absolute directory where a command metric finds the same
artifacts as files, each at `<artifact_dir>/<path>`. It is `null` for HTTP metrics, which get the
artifacts only in the body. For a local command metric the directory is temporary and is removed
once the metric finishes. A sandboxed command metric gets a path inside the sandbox workspace.

A command metric (`kind: exec`) runs once per case. It reads the request on stdin and must write
one [result](#result-shape) on stdout. A non-zero exit, malformed output, or timeout is a metric
error.

```bash
attest metric add scorer --preset command --argv-json '["node","./score.mjs"]' --timeout 30s --output json
```

```json
{
  "definition": { "argv": ["node", "./score.mjs"], "kind": "exec", "timeout_ms": 30000 },
  "id": "scorer",
  "name": "scorer",
  "schema": "attest.metric"
}
```

An HTTP metric (`kind: http`) sends the request as the JSON body. JSON pointers read `score` and
`pass` from the response. `rationale_pointer` and `details_pointer` are optional.

```bash
attest metric add remote --preset http --url https://metrics.example.com/score \
  --score-pointer /score --pass-pointer /pass --output json
```

```json
{
  "definition": {
    "extraction": { "pass_pointer": "/pass", "score_pointer": "/score" },
    "kind": "http",
    "request": { "method": "POST", "url": "https://metrics.example.com/score" }
  },
  "id": "remote",
  "name": "remote",
  "schema": "attest.metric"
}
```

Neither kind has a threshold. Your code decides `pass`.

## Errors and failures

`pass: false` is a result. A metric error (crash, timeout, malformed output, provider failure)
means the metric could not be evaluated. Attest records it separately, never turns it into a
failing score, and compares it between runs like any other outcome.
