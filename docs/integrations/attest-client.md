# Attest client

`@attest/client` is the agent side of the [callback transport](../specs/agent-contract.md#callback-transport).
You host it next to your agent. It accepts attest's trigger, answers `202` at once, runs the
agent in the background and posts an `attest.agent-completion` to the callback URL. A Pi
handler ships with it, so a `pi` coding agent can be evaluated without writing glue.

## Copy-paste example

```ts
import { Effect } from 'effect';
import { createAgentRunner } from '@attest/client';
import { serveAgentRunner } from '@attest/client/node';
import { createPiHandler } from '@attest/client/pi';

/** Owns the listener and accepted invocations until an operator requests shutdown. */
const program = Effect.scoped(
  Effect.gen(function* () {
    const triggerToken = process.env.ATTEST_TRIGGER_TOKEN;

    // A missing token is a deployment mistake, so stop the process instead of recovering.
    if (triggerToken === undefined)
      return yield* Effect.die(new Error('Set ATTEST_TRIGGER_TOKEN.'));

    const runner = yield* createAgentRunner({
      handler: createPiHandler({
        model: process.env.PI_MODEL,
        env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
      }),
      triggerToken,
    });

    const served = yield* serveAgentRunner(runner, { port: 8790 });
    console.log(`Pi runner listening on ${served.url}`);
    yield* Effect.callback<void>((resume) => {
      const stop = () => resume(Effect.void);
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);

      return Effect.sync(() => {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
      });
    });
    yield* served.close();
    yield* runner.close();
  }),
);

await Effect.runPromise(program);
```

```sh
ATTEST_TRIGGER_TOKEN=change-me bun runner.ts
```

Then point a callback agent at it. Save this as `pi-agent.json`:

```json
{
  "schema": "attest.agent",
  "id": "pi",
  "name": "Pi coding agent",
  "transport": {
    "kind": "callback",
    "lifecycle": "external",
    "trigger": {
      "url": "http://127.0.0.1:8790/",
      "method": "POST",
      "headers": { "authorization": { "from_env": "ATTEST_TRIGGER_AUTHORIZATION" } }
    },
    "idempotency_header": "Idempotency-Key"
  },
  "timeouts": { "attempt_ms": 900000 },
  "redaction": { "headers": ["authorization"] }
}
```

```sh
export ATTEST_TRIGGER_AUTHORIZATION='Bearer change-me'
attest agent import ./pi-agent.json --as pi --output json
```

Runnable copies of the runner and a Pi extension live in `packages/client/examples/`.

## Prerequisites

- Node.js 22.15 or newer, or Bun 1.4. The root entry uses Web-standard APIs and bundles for Workers; the host owns deployment lifetime.
- For the Pi handler: `pi` on `PATH` (or pass `argv`), logged in through `pi` itself or given a
  provider key through the handler's `env` option.
- For Pi process cleanup: `ps` on `PATH` with support for `-axo pgid=,stat=`. On Linux, install
  procps. If `ps` is missing or unsupported, cleanup cannot be verified and the runner reports
  `handler_failed`, even when Pi completed successfully.

## Entry points

| Import                | Runs on            | Exports                                    |
| --------------------- | ------------------ | ------------------------------------------ |
| `@attest/client`      | Node, Bun, Workers | `createAgentRunner` and the handler types. |
| `@attest/client/node` | Node, Bun          | `serveAgentRunner`, `collectArtifacts`.    |
| `@attest/client/pi`   | Node, Bun          | `createPiHandler`.                         |

The root entry imports no Node modules, and lint enforces that.

## Runner contract

```ts
const program = Effect.scoped(
  Effect.gen(function* () {
    const runner = yield* createAgentRunner({
      handler: (invocation) => Effect.succeed({ output: invocation.input }),
      triggerToken: 'change-me',
    });
    // Requests return Effects. The host supplies their execution root.
    const response = yield* runner.fetch(request);
    yield* runner.drain();
    yield* runner.close();
    return response;
  }),
);
```

A handler returns exactly one of `output` or `error`, plus optional `artifacts` (inline or
reference), `trace`, `trace_ref` and `state`. The runner adds `protocol`, `run_id` and `case_id`.

Trigger responses:

| Status | When                                                                  |
| ------ | --------------------------------------------------------------------- |
| `202`  | Accepted. Body `{ "accepted": true, "run_id": ..., "case_id": ... }`. |
| `400`  | Not JSON, not an `attest.agent-invocation`, or no `callback` field.   |
| `401`  | The `Authorization` header is not `Bearer <triggerToken>`.            |
| `404`  | Any path other than `/`.                                              |
| `405`  | Any method other than `POST` on `/`.                                  |
| `413`  | Body over 10 MiB, the executor's default request limit.               |
| `415`  | `content-type` is not `application/json`.                             |
| `503`  | The runner is closing.                                                |

A trigger whose callback token was already admitted answers `202` again without starting a second
handler, so attest's idempotent trigger retries are safe. Two tests in one run can send the same
run and case id with different tokens; each gets its own handler.

Completion delivery posts to `callback.url` with `Authorization: Bearer <callback.token>`. It
makes up to three attempts, 250 ms and then 1 s apart, on confirmed `5xx` responses only. Any other
non-`2xx` is final: attest has already judged the completion (`401`, `409` duplicate, `413`
too large). Each attempt times out after 30 s.

Failures the trigger response could no longer report go to `onError` with a `kind`:

| `kind`               | What happened                                       | Completion posted                  |
| -------------------- | --------------------------------------------------- | ---------------------------------- |
| `handler_failed`     | The handler failed through its typed error channel. | `error.code: "handler_failed"`     |
| `invalid_completion` | The result failed the schema or `JSON.stringify`.   | `error.code: "invalid_completion"` |
| `delivery_failed`    | Every delivery attempt failed or was refused.       | none                               |

Closing aborts the handler context signal, allows three seconds for a cooperative terminal result,
then interrupts remaining handlers. Delivery already in flight may use its 30 second attempt bound.
Drain observes accepted fibers for at most 35 seconds and fails if work remains. Close then interrupts
remaining fibers. Terminal Exits and delivery cleanup Causes remain in `runner.receipts`, an internal
in-memory diagnostic map that contains tokens and must never be logged or serialized.
Defects remain defects and do not become `handler_failed` completions. Wrap foreign operations
with `Effect.tryPromise` to classify expected failures:

```ts
Effect.tryPromise({
  try: () => callMyAgent(input),
  catch: (cause) => new AgentHandlerError({ message: 'The agent call failed.', cause }),
});
```

`Effect.promise` turns every rejection into a defect. Drain and close report failures from all
receipts still retained, including earlier calls.
Scope shutdown evidence is in `runner.shutdown`, separate from invocation tokens.

Admission allows 64 concurrent invocations and retains at most 10,000 token receipts. When full,
the oldest completed receipt is evicted; active work is never evicted. Active capacity exhaustion
returns 503. An evicted token is accepted as a new invocation. A retained token never runs a handler
again, even after failed or unconfirmed delivery. Opaque fetch rejection or timeout ends delivery without retry because
remote acceptance is unknown. A confirmed 2xx remains delivered even if body cleanup fails; cleanup
Causes remain in the receipt. A failed cleanup after 5xx also stops retries.

## Bun and Workers hosts

`withAgentRunner(options, use)` brackets use and shutdown and preserves the primary Cause. Prefer it
when the complete lifetime needs a typed error result. Workspace removal is joined until it settles.
Runner close uses its own drain bound without a shorter outer cleanup timeout. Low-level constructors
retain cleanup receipts; explicitly call `close()` before scope disposal to observe shutdown failure
through E.

The native API deliberately replaces Promise handler and operation signatures. Handlers return
`Effect.Effect<HandlerResult, AgentHandlerError>`; constructors require an explicit Scope. A host must retain
that scope across all requests and close admission and drain before disposal. Never run
`Effect.scoped(createAgentRunner(...))` and return the handle: its owner would already be closed.
At the host callback, run `runner.fetch(request)` through the host's Effect execution root. Bun's
server callback and a Worker's fetch callback are foreign roots. Workers also need host-managed
lifetime extension for accepted work. Bundle compatibility alone does not prove a Workers deployment
or private-host lifetime policy.

## Artifacts

`collectArtifacts(root, { include, maxBytes, maxCount })` reads files under `root` into inline
artifacts with forward-slash paths relative to it, sorted by path. Valid UTF-8 is inlined as
`utf8`; anything else as `base64`. The media type comes from the file extension, defaulting to
`application/octet-stream`.

It returns an Effect succeeding with `{ artifacts, skipped }`. A file lands in `skipped` with a `reason`:

- `invalid_path`: the name fails the artifact path rules, for example a backslash, a control
  character or a segment over 255 characters.
- `max_count`: more than `maxCount` files (default 64, the executor's `artifact_count`).
- `max_bytes`: the total would pass `maxBytes` (default 4 MiB, which keeps a base64 completion
  under the default 10 MiB response cap).

Symlinks are skipped, so a link cannot pull a file from outside `root`. `.git` and
`node_modules` directories are not walked. A tree with more than 10,000 files fails through the typed error channel.

## Pi handler

```ts
createPiHandler({
  argv, // default ['pi']; extra arguments such as '-e', './extension.ts' go here
  model, // passed as --model
  systemPrompt, // passed as --system-prompt
  workspace, // (invocation) => Effect.Effect<string, AgentHandlerError>; default: a fresh temp dir, removed afterwards
  env, // extra variables for Pi, such as a provider key; undefined values are left out
  timeoutMs, // default 15 minutes
});
```

For each invocation the handler runs:

```text
<argv...> --mode rpc --no-session --no-extensions --no-skills --no-prompt-templates \
  --no-context-files --no-mcp [--model <model>] [--system-prompt <text>]
```

with the workspace as its working directory. The isolation flags keep machine-wide extensions,
skills and `AGENTS.md` files out of the eval. Explicit `-e <path>` arguments still load.

Pi's shell runs whatever commands the prompt leads it to, so Pi does not inherit the runner's
environment. It gets `PATH` with relative entries removed, `HOME` (where Pi keeps its login and
settings), `TMPDIR`, `LC_ALL=C` and the `env` option. This keeps the trigger token and other
runner secrets out of Pi's environment. It is not a sandbox: the shell can still read any file
the runner's user can.

1. The prompt is `input` when it is a string, else `input.prompt`. Anything else returns
   `error.code: "invalid_input"` without starting Pi.
2. The handler hashes every workspace file with SHA-256.
3. It sends one `prompt` command and reads stdout as strict JSONL, splitting on LF only. Lines
   over 16 MiB end the run. Stdin stays open until `agent_settled`, then closes so Pi exits.
4. `output` is the text of the last assistant `message_end`.
5. `artifacts` are the files whose hash changed or that are new, within the `collectArtifacts`
   defaults of 64 files and 4 MiB. Files past the caps become `artifact_skipped` root events.

| `error.code`         | Cause                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `pi_agent_failed`    | The last assistant message stopped with `error` or `aborted`.                            |
| `pi_no_output`       | Pi settled, or handled the prompt, with no assistant message.                            |
| `pi_prompt_rejected` | Pi answered the prompt command with `success: false`.                                    |
| `pi_exited`          | Pi exited before `agent_settled`; the message has stderr's tail.                         |
| `pi_spawn_failed`    | The command could not start.                                                             |
| `pi_protocol_error`  | A stdout line went over the limit, or a record type the handler reads failed its schema. |
| `timeout`            | Pi did not settle within `timeoutMs`.                                                    |
| `cancelled`          | The signal aborted, or Pi settled with `aborted: true`.                                  |

On abort or timeout the handler kills Pi's process group (SIGTERM, then SIGKILL after 2 s), so
tool subprocesses die with it. Once Pi exits, anything left in its group gets SIGKILL, so a
background process a tool started does not outlive the run. Error completions still carry the
trace and changed files.

### Trace

The trace is an [`attest.trace`](../specs/trace-schema.md):

| Pi records                                    | Span                                          |
| --------------------------------------------- | --------------------------------------------- |
| `agent_start` to `agent_settled`              | `agent.run`, kind `agent`, the root           |
| each `turn_start` to `turn_end`               | `llm.call`, kind `llm`, child of the root     |
| `tool_execution_start` / `tool_execution_end` | `tool.<name>`, kind `tool`, child of the turn |
| `auto_retry_start`, `auto_retry_end`          | events on the root span                       |

Turn spans carry `gen_ai.request.model` (the configured model), `gen_ai.response.model`, and
`gen_ai.usage.input_tokens` / `output_tokens` from the assistant message. Tool spans carry
`gen_ai.tool.name`, `gen_ai.tool.call.id` and `gen_ai.tool.call.arguments` as a JSON string, and
an error status when the result is an error. Arguments or results over 64 KiB are left out
rather than cut, because a cut JSON string no longer parses.

Pi's RPC records have no timestamps. Span times are when the handler received each record,
not times Pi reported. A trace keeps at most 1,000 spans and counts the rest in
`attest.trace.dropped_spans`.

## Post the completion from inside Pi

`packages/client/examples/pi-extension-attest-hook.ts` is a Pi extension that posts the
completion itself on `agent_settled`, reading `ATTEST_CALLBACK_URL`, `ATTEST_CALLBACK_TOKEN`,
`ATTEST_RUN_ID` and `ATTEST_CASE_ID`. Use it when your own process starts Pi. It reports the
final text or error only; the runner is the way to get artifacts and a trace.

## Security

- A trigger makes the handler run a prompt, and Pi has a shell tool. That is why `triggerToken` is
  required. Binding to loopback (the `serveAgentRunner` default) keeps other machines out but not
  a web page that uses DNS rebinding to reach `127.0.0.1`.
- Triggers must be `application/json`. A cross-origin page cannot send that without a CORS
  preflight, and the runner answers the preflight with `405`.
- `triggerToken` is compared in time that depends only on its length. Neither token is logged.
- Completions go wherever `callback.url` says. Only accept triggers from your attest.
