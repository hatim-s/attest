# cURL import and mapped HTTP

Import a captured cURL request when an existing JSON HTTP API does not speak the native Attest envelope. Import parses the command as inert data, replaces selected values with typed input or secret references, and writes a normal `attest.agent/v2` resource.

## Copy-paste example

```sh
mkdir attest-curl-guide && cd attest-curl-guide
cat > request.curl <<'EOF'
curl 'https://api.example.com/v1/answer' \
  -H 'Authorization: Bearer replace-me' \
  -H 'Content-Type: application/json' \
  --data-raw '{"prompt":"replace-me"}'
EOF

attest project init . --name curl-guide --non-interactive --output json
attest agent import ./request.curl \
  --type curl \
  --as support-http \
  --map-body /prompt=/question \
  --header-env Authorization=SUPPORT_API_TOKEN \
  --response-pointer /answer \
  --error-pointer /error \
  --connect-timeout 5s \
  --first-byte-timeout 15s \
  --body-timeout 15s \
  --attempt-timeout 30s \
  --request-cap-bytes 1048576 \
  --response-cap-bytes 1048576 \
  --retries 2 \
  --retry-delay 250ms \
  --output json
attest show agent support-http --output json
```

## Prerequisites

- `attest` on `PATH` and an empty working directory.
- One local UTF-8 cURL file, or `-` to read it from stdin. Remote cURL-source URLs are not supported.
- A JSON API response and the JSON Pointer that selects its final result.

## Expected files

```text
attest-curl-guide/
├── request.curl
├── attest.project.json
└── attest/agents/support-http.json
```

The original cURL bytes and captured bearer value are not copied into the resource.

## Expected stdout

Import emits one `attest.cli-result/v1` document with `ok: true`, `command: "agent.import"`, and a redacted definition preview. `show` emits the persisted resource; its header is a reference:

```json
"Authorization": { "from_env": "SUPPORT_API_TOKEN" }
```

The body contains `"prompt": "{{input/question}}"`, and extraction contains `"result_pointer": "/answer"`.

## Cleanup

```sh
cd ..
rm -rf ./attest-curl-guide
```

## Map the request

Repeat `--map-body TARGET_JSON_POINTER=INPUT_JSON_POINTER` for every request-body field driven by a test case. A mapping must replace an existing body location; import never guesses or creates a missing path. The request above turns this test input:

```json
{ "question": "What is your refund policy?" }
```

into this foreign body:

```json
{ "prompt": "What is your refund policy?" }
```

JSON Pointers follow RFC 6901 escaping: `~1` means `/` and `~0` means `~`. A pointer of `""` selects the whole input. Use repeatable `--query-env QUERY_NAME=SOURCE_ENV` and `--header-env HEADER_NAME=SOURCE_ENV` to replace captured secret values.

## Map the response

`--response-pointer` is required in non-interactive use and must select a JSON value. Optional `--error-pointer` selects a string or `{ "message": string, "code"?: string }`; when present and non-null it becomes a native agent `error` envelope. `--trace-pointer` selects optional trace evidence, and `--remote-job-id-pointer` records a bounded provider correlation id.

Test only after configuring the referenced environment variable:

```sh
export SUPPORT_API_TOKEN='Bearer replace-with-real-token'
attest agent test support-http \
  --input '{"question":"What is your refund policy?"}' \
  --output json
```

## Supported cURL surface

Import supports one URL, one method from `GET`, `POST`, `PUT`, `PATCH`, or `DELETE`, repeated unique headers, URL query values, and one literal or project-contained file-backed body. JSON, raw text, and URL-encoded form bodies are supported. Common display/compression flags such as `--silent`, `--show-error`, and `--compressed` are ignored.

Unsupported or unsafe flags are reported together before any project write. This includes redirects, proxies, cookies, netrc, client certificates, uploads, multipart forms, binary data, user/password flags, and shell control or expansion syntax.

## Security and redaction

- Import never executes cURL or a shell. Semicolons, pipes, redirects, backticks, `$()` and `${}` are rejected.
- Credential-shaped header/query names require an environment binding. Credential-shaped JSON or form fields are rejected because body-secret substitution is not implemented.
- File-backed bodies must be regular, project-contained files and cannot traverse or escape through symlinks.
- At runtime, secrets require HTTPS except on explicit loopback endpoints. DNS is resolved and pinned; private and special-use destinations are rejected except loopback.
- Mapped HTTP follows only bounded, method-preserving, same-origin redirects. Polling URLs must also keep the submission origin.
- Captured secrets are discarded at import. Probe output, persisted evidence, response excerpts, and errors redact resolved secret values.

## Cancellation, retries, and stable errors

Ctrl-C aborts DNS, connect, response, retry waits, and body reads. The CLI returns `cancelled` with exit code `130`. The whole request is also bounded by `--attempt-timeout`.

Retries cover safe transport failures and retryable HTTP statuses; agent-reported errors are results and are not retried. Use `--retries 0` for a non-idempotent direct endpoint unless the endpoint itself makes duplicate requests safe.

Automation should inspect `attest.cli-result/v1`. Top-level transport failures use `invocation_failed` with exit code `4`; `details.invocation_code` distinguishes `network`, `timeout`, `http_status`, `output_cap_exceeded`, and `invalid_envelope`. Discover the current grammar and catalog with:

```sh
attest help agent import --output json
attest errors --output json
```
