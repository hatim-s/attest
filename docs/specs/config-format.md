# Config Format — `attest.config`

Evaluation is declared in files: git-versioned, diffable, CI-friendly. YAML is the documented authoring format; JSON is accepted everywhere with identical semantics. The dashboard's editor writes back to these files without disturbing comments or formatting.

Default discovery order: `attest.config.yaml`, `attest.config.yml`, `attest.config.json` in the working directory; override with `attest run --config <path>`.

## Example

```yaml
config_version: 1
project: support-agent

agent:
  type: cli # cli | http
  command: ['bun', 'run', 'src/agent.ts']
  # url: http://localhost:3000/invoke   (type: http)
  env: [ANTHROPIC_API_KEY] # allowlist forwarded to the agent
  timeout_ms: 60000
  retries: 1

suites:
  - name: smoke
    metrics: [answer-correctness, no-failed-tools]
    cases:
      - id: greeting
        input: { question: 'What is the capital of France?' }
        expected: { answer: 'Paris' }
      - id: refund-policy
        input: { question: 'How do refunds work?' }

  - name: regression
    dataset: ./datasets/regression.jsonl
    metrics: [answer-correctness]

metrics:
  - name: answer-correctness
    type: judge
    model: anthropic/claude-sonnet-5
    rubric: |
      Score 1 if the answer is factually consistent with `expected`
      and directly addresses the question; otherwise 0.

  - name: no-failed-tools
    type: assertion
    assert:
      - tool_calls: { status: ok } # trace-based; see metric contract

  - name: brand-voice
    type: exec
    command: ['python3', 'metrics/brand_voice.py']

run:
  concurrency: 4
  output_cap_bytes: 10485760
```

## Top-level fields

| Field            | Required | Notes                                                                                        |
| ---------------- | -------- | -------------------------------------------------------------------------------------------- |
| `config_version` | yes      | Currently `1`. Configs with unknown versions are rejected.                                   |
| `project`        | no       | Display name for runs; defaults to directory name.                                           |
| `agent`          | yes      | How to invoke the agent — see [agent contract](./agent-contract.md).                         |
| `suites`         | yes      | One or more named suites of cases.                                                           |
| `metrics`        | yes      | Named metric definitions referenced by suites — see [metric contract](./metric-contract.md). |
| `run`            | no       | Runner settings: `concurrency` (default 4), `timeout_ms` fallback, `output_cap_bytes`.       |

## Cases

Inline `cases` and file-backed `dataset` are interchangeable per suite (a suite may use either, not both).

- Case fields: `id` (required, unique within suite), `input` (required, arbitrary JSON), `expected` (optional reference data — metrics read it, the agent never sees it), `params` (optional passthrough sent to the agent), `metrics` (optional per-case override list).
- Datasets are JSONL: one case object per line, same fields as inline cases.

## Rules

1. **Strict validation.** Unknown fields anywhere are rejected — with source locations (file:line) and every error reported at once, before any agent is invoked. The published JSON Schema (`schemas/config.v1.json`) is generated from the same definitions the runtime validates with.
2. **YAML/JSON equivalence.** Any config expressible in one is expressible in the other; the YAML subset used is JSON-compatible (no anchors, no merge keys, no non-string keys — these are rejected with a pointed error).
3. **Environment interpolation** happens only in designated fields (`agent.env` names, judge `model` credentials resolution) — never arbitrary `${VAR}` templating in bodies. Secrets stay out of config files.
4. **Determinism inputs.** The config's canonical hash (comments and formatting excluded) is recorded on every run and shown in diffs — "what changed between run A and B" always includes config identity.
5. **Editor round-trip.** Tools that modify configs (the dashboard editor, `attest init`) patch the concrete syntax tree: comments, key order, quoting, and untouched lines survive. A file changed on disk since load is refused, never clobbered.
