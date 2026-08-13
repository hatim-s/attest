# WebSocket integrations

Use the WebSocket adapter for plain RFC 6455 endpoints that exchange correlated UTF-8 JSON messages. The adapter supports one connection per case or a serial/multiplexed connection shared by an eval run.

## Copy-paste example

```sh
mkdir attest-websocket-guide && cd attest-websocket-guide
attest project init . --name websocket-guide --non-interactive --output json
attest agent add support-ws \
  --websocket-url ws://127.0.0.1:8790/agent \
  --websocket-lifecycle per_run \
  --connection-mode multiplexed \
  --subprotocol attest-agent \
  --header-env Authorization=SUPPORT_WS_TOKEN \
  --request-template '{"request_id":"{{request_id}}","kind":"invoke"}' \
  --request-id-pointer /request_id \
  --acknowledgement-pointer /type \
  --response-pointer /output \
  --error-pointer /error \
  --open-timeout 5s \
  --idle-timeout 20s \
  --attempt-timeout 30s \
  --ping-interval 10s \
  --close-timeout 5s \
  --output json
attest show agent support-ws --output json
```

## Prerequisites

- `attest` on `PATH` and a plain `ws://` or `wss://` RFC 6455 server.
- Text JSON messages with a correlation field echoed on every application message.
- An explicit acknowledgement message before work becomes non-replayable.

## Expected files

```text
attest-websocket-guide/
├── attest.project.json
└── attest/agents/support-ws.json
```

The resource stores an environment reference for `Authorization`; it never stores `SUPPORT_WS_TOKEN`.

## Expected stdout

`agent add` emits one `attest.cli-result` document with `ok: true`, `command: "agent.add"`, and a redacted `definition_preview`. `show` reports transport `kind: "websocket"`, `framing: "text_json"`, `retry_boundary: "before_acknowledgement"`, and `replay_after_acknowledgement: false`.

After starting the endpoint and exporting the token, probe it with:

```sh
export SUPPORT_WS_TOKEN='Bearer replace-with-real-token'
attest agent test support-ws --input '{"question":"hello"}' --output json
```

## Cleanup

```sh
cd ..
rm -rf ./attest-websocket-guide
```

## Messages and correlation

Attest renders the one `{{request_id}}` slot, then supplies the normalized protocol, request id, and native request. With the example template, the server receives:

```json
{
  "request_id": "ws-…",
  "kind": "invoke",
  "protocol": "attest.websocket-request",
  "request": {
    "protocol": "attest.agent-invocation",
    "run_id": "…",
    "case_id": "…",
    "input": { "question": "hello" }
  }
}
```

Every application response must be a text JSON object. The configured `--request-id-pointer` must select the exact outstanding id. Unknown, missing, completed, or duplicate ids are protocol failures.

`agent add` defaults the accepted acknowledgement value to the JSON string `"acknowledgement"`; the canonical resource stores accepted values in `acknowledgement_values`. Send an acknowledgement before terminal output:

```json
{ "request_id": "ws-…", "type": "acknowledgement" }
```

Then send either a result or error:

```json
{ "request_id": "ws-…", "output": "hello", "error": null }
```

```json
{ "request_id": "ws-…", "error": { "code": "agent_failed", "message": "No answer." } }
```

Optional trace messages may arrive before the terminal message when `--trace-pointer` is configured. Each extraction pointer must be distinct.

## Lifecycle and retries

- `per_case` opens one connection per case and requires `--connection-mode serial`.
- `per_run` reuses a run-scoped connection. Choose `serial` unless the server deliberately supports concurrent ids; `multiplexed` permits out-of-order messages.
- Network and timeout failures may retry only before an accepted acknowledgement. After acknowledgement, Attest never reconnects or replays because remote side effects may already exist.
- The ping interval must be shorter than message idle timeout. Open and idle timeouts must not exceed the whole attempt timeout. The close timeout bounds the graceful close handshake.

Ctrl-C cancels pending work, closes or destroys the connection, and returns top-level `cancelled` with exit `130`. The current adapter does not define an application-level remote cancellation message.

## Security and redaction

- Use `wss://` whenever credentials are resolved. Plain `ws://` with secrets is allowed only for explicit loopback endpoints.
- `Authorization` must be an environment/file secret reference. Cookies, proxy authorization, and runtime-controlled handshake headers are rejected.
- The server must select exactly the configured subprotocol. Socket.IO endpoints, GraphQL subscription subprotocols, binary frames, and arbitrary bidirectional tool callbacks are unsupported.
- URLs cannot contain credentials or fragments. DNS is resolved and pinned; private and special-use addresses are rejected except loopback.
- Request bytes, message bytes, message count, and total evidence are bounded. Resolved header values and configured event pointers are redacted from persisted attempt evidence and errors.

## Testing and stable errors

Test serial and multiplexed correlation, acknowledgement timing, clean/unclean close, ping/pong, idle timeout, invalid JSON, unknown ids, cap overflow, and cancellation against a local fake before using production credentials.

`agent test --output json` uses top-level `invocation_failed` with exit `4` for transport failures. Inspect `details.invocation_code` (`network`, `timeout`, `invalid_envelope`, or `output_cap_exceeded`) and the bounded attempt evidence instead of parsing messages. Discover the exact installed grammar and stable error catalog with:

```sh
attest help agent add --output json
attest errors --output json
```
