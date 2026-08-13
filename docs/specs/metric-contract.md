# Metric Contract — `attest.metric-evaluation`

Three kinds of metrics score every case: **assertions** (declarative, deterministic), **exec metrics** (your code, any language), and **judges** (LLM-scored rubrics). All three normalize to the same result shape, so reports, diffs, and CI thresholds treat them uniformly.

## Result shape

Every metric evaluation produces:

```json
{
  "score": 1,
  "pass": true,
  "rationale": "Answer names Paris and cites the expected source.",
  "details": { "matched": ["$.output"] }
}
```

| Field       | Type    | Required | Notes                                                              |
| ----------- | ------- | -------- | ------------------------------------------------------------------ |
| `score`     | number  | yes      | Typically 0–1; any finite number allowed (thresholds decide pass). |
| `pass`      | boolean | yes      | The verdict used by diffing and CI gates.                          |
| `rationale` | string  | no       | Human-readable justification — judges always set it.               |
| `details`   | JSON    | no       | Structured evidence (matched paths, sub-scores, token usage).      |

## 1. Assertions (`type: assertion`)

Deterministic checks evaluated in-process. An assertion metric is a list of checks; all must hold (`pass = all(checks)`, `score = fraction passed`).

```yaml
assert:
  - contains: { path: '$.output', value: 'Paris' }
  - regex: { path: '$.output', pattern: '(?i)capital' }
  - equals: { path: '$.output.answer', value: 'Paris' }
  - json_schema: { path: '$.output', schema: { type: object, required: [answer] } }
  - threshold: { path: '$.trace.usage.output_tokens', lt: 500 }
  - tool_calls: { status: ok }
  - tool_calls:
      name: search
      arguments:
        - contains: { path: '$.query', value: 'France' }
        - equals: { path: '$.limit', value: 5 }
  - spans:
      filter: { kind: llm, status: ok, attributes: { gen_ai.request.model: gpt-5 } }
      count: 1
  - not: { contains: { path: '$.output', value: "I don't know" } }
  - any:
      - equals: { path: '$.output.answer', value: 'Paris' }
      - equals: { path: '$.output.answer', value: 'paris' }
```

**Paths** are a deliberate subset of JSONPath: `$` roots the evaluation document `{ input, output, expected, trace }`; dot fields and `[n]` indexing only — no wildcards, filters, or recursion in v0.

**Check set v0**: `equals`, `contains` (string or array containment), `regex` (JavaScript `RegExp` syntax as `{path, pattern, flags?}`; the engine executes patterns under a per-check time guard), `json_schema` (Draft 2020-12), `threshold` (`lt`/`lte`/`gt`/`gte` on numbers), `exists`, `tool_calls`, `spans`, and combinators `all`, `any`, `not`. Combinator arrays, argument matcher arrays, and `assert` lists must be non-empty — vacuously-true collections are rejected at config validation.

`tool_calls.name` matches the `gen_ai.tool.name` attribute, falling back to the span name. `status` and exact `count` apply to the matching calls; `order` compares their semantic names chronologically. `arguments` requires at least one matching call whose `gen_ai.tool.call.arguments` JSON satisfies every `equals`, `contains`, and `exists` matcher. Structured span `input` is the fallback when the standardized argument attribute is absent.

`spans.filter` can select by `kind`, span `name`, `status`, and a partial exact attribute map. A filter by itself requires at least one match; `count` and chronological `order` apply to the filtered span set when supplied. Missing or malformed trace evidence produces a normal failed assertion, never a metric-engine exception.

## 2. Exec metrics (`type: exec`)

Your scoring code, invoked exactly like an agent — mirror-image contract, any language:

- **CLI**: `command` is spawned per case; stdin receives the evaluation document; stdout must be one JSON result. Exit code ≠ 0, malformed output, or timeout = metric error (recorded, does not crash the run).
- **HTTP**: `url` receives `POST` with the same body; `200` + result JSON.

Request body:

```json
{
  "protocol": "attest.metric-evaluation",
  "case": { "id": "greeting", "input": {}, "expected": {}, "params": {} },
  "output": "…the agent's output…",
  "trace": { "schema": "attest.trace", "spans": [] }
}
```

`trace` is `null` when the agent emitted none. Response body is the [result shape](#result-shape); `pass` is required — attest never guesses a threshold for you.

## 3. Judges (`type: judge`)

Built-in LLM-as-judge with BYO keys (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` from the environment — keys never appear in config or results).

```yaml
- name: answer-correctness
  type: judge
  model: anthropic/claude-sonnet-5
  rubric: |
    Score 1 if the answer is factually consistent with `expected`, else 0.
  threshold: 0.5 # pass = score >= threshold (default 0.5)
```

Semantics:

- The judge sees `input`, `output`, `expected`, and (when present) a compact trace summary — never other cases' data.
- `score` is parsed from a structured response; `rationale` is always captured.
- **Reproducibility**: the full judge request (model, prompt, params) and raw response are recorded with the run; reports show exactly what the judge saw. Judge calls are cached by content hash — unchanged case + unchanged output + unchanged rubric = no repeat API call.
- Judge failures (provider errors, unparseable responses after retry) are metric errors, distinct from `pass: false`.

## Errors vs failures

`pass: false` is a _result_. A **metric error** (crash, timeout, malformed envelope, provider failure) means the case's metric could not be evaluated: it is reported separately, never silently coerced to a failing score, and is itself diffable between runs.

Executable metrics should ignore unknown request fields so vendor-specific extensions remain usable.
