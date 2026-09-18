# Native agent integrations

Use the native `attest.agent-invocation` envelope when you control the agent process or HTTP endpoint. It is the smallest integration surface: Attest sends one JSON request and expects one JSON response.

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
  protocol: 'attest.agent-invocation',
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

Each command using `--output json` writes one `attest.cli-result` document. The final document has `ok: true`, `command: "agent.test"`, and a `result.response.output` equivalent to:

```json
{ "echoed": { "question": "hello" } }
```

The example log is written to stderr, so it never corrupts the response envelope.

## Cleanup

```sh
cd ..
rm -rf ./attest-native-guide
```

## Run a native agent in Vercel Sandbox

Vercel Sandbox is an opt-in remote execution mode for `native_cli`. Attest can run locally while
each case runs in a Vercel-managed sandbox. This mode needs network access and Vercel
credentials, so it does not provide a local or offline sandbox.

Pass the complete sandbox definition when you author the agent:

```sh
attest agent add remote-echo \
  --argv-json '["node","./agent.mjs"]' \
  --sandbox-json '{"kind":"vercel","files":[{"source":"agent.mjs","destination":"agent.mjs"}],"artifacts":[{"source":"result.json","destination":"result.json"}],"artifact_directory":".attest/artifacts"}' \
  --timeout 30s \
  --output json
```

The stored `sandbox` object has this shape:

```json
{
  "kind": "vercel",
  "image": "vercel/sandbox/universal",
  "files": [{ "source": "agent.mjs", "destination": "agent.mjs", "mode": 493 }],
  "artifacts": [{ "source": "result.json", "destination": "result.json" }],
  "artifact_directory": ".attest/artifacts"
}
```

`image`, `artifacts`, and `artifact_directory` are optional. Omitting `image` selects
`vercel/sandbox/universal`. `artifact_directory` is required when artifacts are configured and the
eval does not have worker directories. An `agent test` probe uses its own unique artifact root.

Attest transfers only the regular files named in `files`. Each `source` is a fixed project-relative
file and each `destination` is its sandbox path. Attest does not expand globs, upload directories,
follow symbolic links, or infer files from argv. List the executable and every runtime dependency
that the command needs. `mode` is the optional numeric file mode, such as decimal `493` for octal
`0755`.

The sandbox workspace is `/vercel/sandbox/workspace`. A transport `cwd` resolves relative to that
directory. Relative argv entries also remain relative inside the sandbox. Attest does not rewrite
them to an absolute path from the host project.

Artifact transfer is similarly explicit. After the command finishes, Attest downloads each regular
file named by `artifacts[].source`. It does not download directories, globs, symbolic links, or
unlisted sandbox files. When the eval has a worker directory, Attest writes each artifact to:

```text
<worker_directory>/<mapping.destination>
```

Without a worker directory, Attest writes it to a per-case directory under the configured root:

```text
<project>/<artifact_directory>/<run_id>/<configured_index>/<mapping.destination>
```

The agent's existing `limits.response_bytes` bounds each uploaded file, each downloaded artifact,
and both aggregate transfer totals in this first version. The same limit still bounds stdout.

Each case gets a fresh sandbox. Attest uploads the configured files once, reuses that sandbox for
the case's configured retries, and downloads artifacts after the terminal attempt. It stops the
sandbox before the eval runs `after_case`. Changes made by an earlier retry remain visible to later
retries for the same case.

Set either `VERCEL_OIDC_TOKEN` or the complete `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and
`VERCEL_PROJECT_ID` set in the environment that launches Attest. See [Environment
variables](../ENV.md). Never put their values in the agent resource.

## Request and response contract

For a foreground CLI agent, Attest writes exactly one request document to stdin. Required request fields are `protocol`, `run_id`, `case_id`, and `input`; multi-turn runs may also include `messages`, `turn_index`, `conversation_id`, and `state`.

Write exactly one response document to stdout:

```json
{
  "protocol": "attest.agent-invocation",
  "output": "the final answer"
}
```

Use `error` instead of `output` when the agent handled the request but could not answer:

```json
{
  "protocol": "attest.agent-invocation",
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
- A `native_cli` process runs as trusted local code unless its resource opts into Vercel Sandbox.
  Attest supervises and terminates local processes. Vercel-sandboxed processes run remotely in a
  fresh sandbox for each case.

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
