# Polling and streaming integrations

Use polling for submit-then-check APIs. Use streaming for an HTTP response that carries SSE events or newline-delimited JSON until a configured terminal event arrives.

## Copy-paste example

```sh
mkdir attest-async-guide && cd attest-async-guide
cat > submit.curl <<'EOF'
curl 'http://127.0.0.1:8787/jobs' \
  -H 'Content-Type: application/json' \
  --data-raw '{"prompt":"replace-me"}'
EOF

attest project init . --name async-guide --non-interactive --output json
attest agent import ./submit.curl --type curl --as polling-agent \
  --map-body /prompt=/question \
  --response-pointer /answer --error-pointer /error \
  --poll-job-id-pointer /job_id \
  --poll-status-url-template 'http://127.0.0.1:8787/jobs/{{job_id}}' \
  --poll-status-pointer /status \
  --poll-success '"completed"' --poll-failure '"failed"' \
  --poll-minimum-interval 250ms --poll-maximum-interval 2s \
  --idempotency-header Idempotency-Key \
  --attempt-timeout 30s --retries 2 --output json
attest agent add stream-agent \
  --stream-url http://127.0.0.1:8788/events \
  --stream-framing sse --event-name message \
  --terminal-pointer /type \
  --response-pointer /output --error-pointer /error \
  --incremental-output-pointer /delta --incremental-output-mode text \
  --timeout 30s --output json
```

## Prerequisites

- `attest` on `PATH` and two external or loopback JSON endpoints.
- Polling: a submission response containing a job id and either a same-origin status URL or enough data to render one.
- Streaming: SSE `data:` values or JSONL lines that each decode to one JSON value.

## Expected files

```text
attest-async-guide/
├── submit.curl
├── attest.project.json
└── attest/agents/
    ├── polling-agent.json
    └── stream-agent.json
```

Authoring does not contact either endpoint and does not create `.attest/runs.db`.

## Expected stdout

Both authoring commands emit one `attest.cli-result/v1` document with `ok: true`. Their `command` values are `agent.import` and `agent.add`. The persisted transport kinds are `polling` and `stream`.

When the endpoints are running, probe with:

```sh
attest agent test polling-agent --input '{"question":"hello"}' --output json
attest agent test stream-agent --input '{"question":"hello"}' --output json
```

## Cleanup

```sh
cd ..
rm -rf ./attest-async-guide
```

## Polling contract

Submission uses the imported request mapping. `--poll-job-id-pointer` must select a string or number. Configure exactly one status URL source:

- `--poll-status-url-pointer /status_url` reads the URL from the submission response.
- `--poll-status-url-template 'https://api.example.com/jobs/{{job_id}}'` renders the extracted job id.

The status URL must retain the exact submission origin. Polls are `GET` requests and carry submission headers except `content-length`, `content-type`, and the configured idempotency header.

`--poll-status-pointer` selects the current state. Each repeatable `--poll-success` and `--poll-failure` value is parsed as JSON and compared structurally; the two sets must not overlap. On success, normal result/error/trace extraction runs against the terminal poll body.

### Retry and timing rules

The attempt timeout spans submission, every wait, all polls, and terminal extraction. `Retry-After` is honored within the configured minimum/maximum interval; otherwise the poll interval doubles up to the maximum.

Submission retries are allowed only when `--idempotency-header` is configured and before a job id is observed. Attest generates a stable per-case header value. Safe polling transport failures and retryable HTTP statuses may use the configured retry budget. Cancellation stops local polling; remote cancellation is not implemented.

## SSE and JSONL stream contract

For SSE, return `Content-Type: text/event-stream` and put one JSON value in the combined `data:` fields of each event:

```text
event: message
data: {"type":"delta","delta":"hel"}

event: message
data: {"type":"result","output":"hello"}

```

For a newline-delimited server stream, use `--stream-framing jsonl` and send the same JSON objects one per nonblank line. `--event-name` filters SSE application events and is not used for JSONL framing.

`agent add` defaults terminal detection to `/type` equal to the JSON string `"result"`; the example makes the pointer explicit. The canonical resource stores the accepted values in `terminal_values`. `--response-pointer`, optional `--error-pointer`, and optional `--trace-pointer` read the terminal event. Incremental output is evidence: `text` concatenates string deltas; `array` appends JSON values. It does not replace the required terminal result.

SSE comment lines are heartbeats. They reset transport idle time; they reset application idle time only when a complete imported resource sets `heartbeat_resets_application_idle: true`.

## Security, caps, and redaction

- Use `--header-env HEADER=SOURCE_ENV` for credentials. Resolved secrets require HTTPS except on explicit loopback and are redacted from event evidence and errors.
- HTTP destinations are DNS-pinned and reject private or special-use addresses except loopback. Redirects and polling status URLs must stay same-origin.
- Streams are bounded by request bytes, event count, event bytes, and total evidence bytes. A complete `attest.agent/v2` JSON import can set `limits` and `redaction.event_pointers`.
- An event above a cap produces `output_cap_exceeded`; malformed UTF-8/JSON or EOF without a terminal event produces `invalid_envelope`.

## Cancellation, testing, and stable errors

Ctrl-C closes the active request and returns stable top-level error `cancelled` with exit `130`. Idle or attempt deadlines return `invocation_failed`, exit `4`, with `details.invocation_code: "timeout"`. Network, HTTP, extraction, and framing failures keep their stable inner code in the same field.

Test terminal success, configured failure, retryable status, `Retry-After`, idle timeout, malformed event, cap overflow, and cancellation against a local fake before using production credentials.

```sh
attest help agent import --output json
attest help agent add --output json
attest errors --output json
```
