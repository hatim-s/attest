# Native agent integrations

Use the native `attest.agent/v1alpha1` envelope when you control the agent process or HTTP endpoint. It is the smallest integration surface: Attest sends one JSON request and expects one JSON response.

## Copy-paste example

```sh
mkdir attest-native-guide && cd attest-native-guide
cat > agent.mjs <<'EOF'
// A foreground native agent receives one request document and writes one response document.
let source = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) source += chunk;
const request = JSON.parse(source);
process.stderr.write(`handling ${request.case_id}\n`);
process.stdout.write(JSON.stringify({
  protocol: 'attest.agent/v1alpha1',
  output: { echoed: request.input }
}));
EOF

attest project init . --name native-guide --non-interactive --output json
attest agent add local-echo \
  --argv-json '["node","./agent.mjs"]' \
  --timeout 30s \
  --output json
attest agent test local-echo --input '{"question":"hello"}' --output json
```

## Prerequisites

- `attest` on `PATH` and Node.js 22 or newer for this example.
- An empty working directory. `project init` refuses conflicting generated paths.
- The command must be executable without a shell. Prefer `--argv-json` when an argument contains spaces or punctuation.

## Expected files

```text
attest-native-guide/
├── agent.mjs
├── attest.project.json
└── attest/agents/local-echo.json
```

`agent test` is a connection probe and does not create `.attest/runs.db` unless `--record` is passed.

## Expected stdout

Each command using `--output json` writes one `attest.cli-result/v1` document. The final document has `ok: true`, `command: "agent.test"`, and a `result.response.output` equivalent to:

```json
{ "echoed": { "question": "hello" } }
```

The example log is written to stderr, so it never corrupts the response envelope.

## Cleanup

```sh
cd ..
rm -rf ./attest-native-guide
```

## Request and response contract

For a foreground CLI agent, Attest writes exactly one request document to stdin. Required request fields are `protocol`, `run_id`, `case_id`, and `input`; multi-turn runs may also include `messages`, `turn_index`, `conversation_id`, and `state`.

Write exactly one response document to stdout:

```json
{
  "protocol": "attest.agent/v1alpha1",
  "output": "the final answer"
}
```

Use `error` instead of `output` when the agent handled the request but could not answer:

```json
{
  "protocol": "attest.agent/v1alpha1",
  "error": { "code": "tool_unavailable", "message": "Search is unavailable." }
}
```

Exactly one of `output` and `error` is required. An `error` envelope is an agent result; malformed JSON, a non-zero exit, timeout, or missing envelope is an invocation failure.

## Native HTTP

An endpoint that already speaks the same envelope needs no response mapping:

```sh
attest agent add native-api \
  --native-http https://agent.example.com/invoke \
  --header-env Authorization=AGENT_API_TOKEN \
  --timeout 30s \
  --output json
```

Attest sends `POST` with the native request envelope as JSON and requires a native response envelope. `--header-env Authorization=AGENT_API_TOKEN` stores `{ "from_env": "AGENT_API_TOKEN" }`, not the environment value. Set the variable only in the process that runs `agent test` or `eval run`.

## Security and redaction

- Foreground commands are argv arrays, not shell programs. Attest does not expand pipes, redirects, command substitutions, or environment variables in argv.
- `cwd` must be project-relative and resolve inside the project. The child receives a minimal environment plus only values explicitly referenced with repeatable `--env TARGET=SOURCE_ENV`.
- Never pass credentials as argv literals. They can appear in process listings and command diagnostics. Use `--env` or `--header-env` references.
- stdout and HTTP bodies are bounded. Unknown response fields are warnings; raw evidence and stderr excerpts are bounded and secret values are redacted before probe output or persistence.
- Treat the agent process as trusted code. Attest supervises and terminates it, but does not sandbox it.

## Testing and cancellation

Probe the exact resource before attaching it to a test:

```sh
attest agent test local-echo --input-file ./probe-input.json --output json
```

`--input` accepts one JSON value; strings therefore need JSON quoting, for example `--input '"hello"'`. Ctrl-C or SIGTERM cancels the probe. Attest terminates a foreground process tree and returns stable CLI error `cancelled` with exit code `130`. A deadline returns `invocation_failed` with `details.invocation_code: "timeout"` and exit code `4`.

## Stable errors

Use machine output in automation:

```sh
attest errors --output json
attest help agent add --output json
attest help agent test --output json
```

Transport failures use stable inner codes such as `spawn_failed`, `nonzero_exit`, `timeout`, `output_cap_exceeded`, `network`, and `invalid_envelope`. `agent test --output json` exposes that value at `details.invocation_code`; do not parse human messages.
