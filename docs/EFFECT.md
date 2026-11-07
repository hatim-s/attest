# Effect in Attest

Attest uses Effect 4.1.2 for operations and resource lifetime. Package ownership is
specified in [ARCHITECTURE.md](ARCHITECTURE.md). The installed Effect source is the
reference for API signatures. Do not mix v3 platform packages into this version.

## Operations and composition

An operation that reads files, stores records, invokes agents, evaluates remote
metrics, waits or schedules work returns `Effect.Effect<A, E, R>`. Expected failures
belong in `E`; dependencies remain in `R` until the application supplies them.
Pure selection, seeded sampling, comparison, analytics, hashing, normalization and
import transformations stay synchronous.

Capture dependencies once in an `Effect.gen` constructor and use named `Effect.fn`
operations. Use `Context.Service` for replaceable application dependencies such as
stores and cancellation registries. Infer implementation shapes where practical.
Host contracts such as `RunSource` declare concrete operation and error types.
Avoid a service per helper or forwarding classes that add no ownership.

Use `Layer.effect` for effectful construction and `Layer.succeed` for constructed
values. Reuse layer objects within an application build. Separate builds acquire
separate resources; `Layer.fresh` does not repair incorrect provisioning.

Wrap individual foreign SDK, fetch, filesystem or driver calls in
`Effect.tryPromise`. Do not wrap a whole Promise coordinator or turn native
operations back into Promise helpers. Foreign callbacks can return Promises at
the host boundary. Application code composes operations with `yield*`.

## Execution roots

`effectRoots` in `eslint.config.mjs` declares the exact files, execution operations
and owners allowed to run Effects. The boundary rule rejects execution elsewhere,
including aliases and hidden namespace access. It also rejects unused declared
operations. Tests have explicit roots too.

The CLI root runs the application once. Hono request handlers, TanStack query and
mutation callbacks, client fetch handlers and Node listener callbacks run native
programs at their declared host boundaries. A request root does not own detached
work admitted by the application. Any runtime for repeated callbacks must have
one explicit disposer. Never create a runtime per store method.

Only approved Effect core modules are allowed. Platform and companion imports
require an architecture decision. Data-only core `/records`, core `/analytics`
and API `/contract` entries use Schema, SchemaIssue, SchemaAST and JsonSchema.
Two exact schema owners also use construction dependencies: core
`records/page-schemas.ts` uses Effect; API `contract/requests.ts` uses Effect and
SchemaGetter. These exceptions do not permit executing Effects.

Browser entries reject Node and Bun built-ins. API `/client`, web and the portable
agent client may use portable core Effect modules. Executor `/http` must not
eagerly import process or sandbox implementations. Process support still requires
a process-capable host. Server packages support Node 22.15+ and Bun 1.4+.

## Errors and outcomes

Use `Data.TaggedError` for internal errors and `Schema.TaggedError` when the error
needs a schema. Keep expected operational errors separate from defects and
interruption. Persisted failed cases, agent-reported failures, metric scores and
requested cancellation responses are domain outcomes, not automatically failures.

Preserve original causes and safe context. Map public codes exhaustively at the
edge. Never classify errors by message text, use blanket `orDie`, or turn failed
reads into missing records or empty lists. A disconnect, user cancellation and a
deadline are different inputs even if each can interrupt a fiber.

Keep the full `Cause` internally. Inspect reason tags and `Cause.hasInterrupts`,
never `Cause.pretty`. Credentials, owner tokens, raw Causes and database details
must not enter public responses or logs.

## Resources, cancellation and cleanup

Register release immediately after acquisition with Scope or an owned bracket.
Stop admission and join dependent fibers before closing their stores, sockets,
environments or processes. Use Deferred for one-time handshakes and queues or
generations for repeated events. Bound concurrency, queues and foreign reads.

Cleanup follows the owner's result policy:

1. Ordinary finalizers have no typed failure channel. They capture every failed
   release, including defects, in an owner-local receipt. They attempt all cleanup
   steps and do not throw or call `orDie`.
2. A primary typed failure stays primary. Interruption stays interruption. Both
   retain cleanup Causes internally. After primary success, failed cleanup becomes
   a typed error retaining the completed value or explicit completion flags. A
   close failure never authorizes replay of a successful mutation.
3. Primary defects stay defects. Public edges select the internal error code and
   retain redacted diagnostics. Capturing cleanup cannot turn a defect into success.

Project rollback is a compensating durable mutation. Failed restoration or journal
cleanup reports `project_recovery_required` with transaction identity and both
Causes. Confirmed restoration preserves the domain error or maps the foreign
failure to `project_transaction_failed`. Defects and interruption keep their Cause.
A fallible bracket release must inspect the primary Exit and fail only after
success; otherwise capture release failures and choose the result afterward.

Mask accepted acquisition/publication steps and release where required to settle
ownership. Keep normal work interruptible. A bound around uncooperative foreign
cleanup needs interruptible observation inside masked release. Timeout means
cleanup is unconfirmed, not that a process stopped. Preserve process-tree identity,
signal grace and descendant verification. Never reuse uncertain environments.

Business cancellation requests abort through the owner's controller. Join admitted
work, final hooks, accepted evidence and cleanup before returning. Observation
ending does not prove a foreign operation stopped. Unknown dispatch or cleanup
prohibits replay. Keep late-response receipts when foreign completion can arrive
after bounded observation.

## Schemas and parsing

Contracts own protocol schemas; core owns stored record and dashboard projection
schemas. Decode untyped input once through the shared contracts parser. Typed
application code trusts the decoded union. `tools/anti-slop` enforces decoder
ownership. Direct Schema decoder references, legacy Zod decoding and hidden
dynamic imports must not bypass it.

Preserve strip versus strict unknown-key handling, defaults, coercion, nullability,
refinements, issue paths, wire identifiers and canonical hashes. Keep internal
`_tag` fields out of public envelopes. Generated JSON schemas use Draft 2020-12;
the exact generated-content check guards published artifacts. AJV handles
user-supplied JSON Schema metrics. Foreign Standard Schema adapters and schema
construction transformations remain allowed.

## Stores and local state

`@attest/local/store` exports `withStoreScope`, `openStore`,
`openReadonlyRunStore` and the opaque `StoreScope` type. Constructors capture the
owner and return Effects without an ambient Scope requirement. Store and catalog
methods require no services. There is no public store `close()`.

```ts
const program = withStoreScope((owner) =>
  Effect.gen(function* () {
    const store = yield* openStore(path, owner);
    return yield* store.runs.listRuns();
  }),
);
```

The callback must remain alive through all store work. Returning a listener,
catalog or event source closes its stores; escaped methods fail. One owner shares
successful opens for a resolved path. Mixing readonly and writable modes fails.
Separate owners acquire separately. Failed acquisition closes immediately and is
not cached. Readonly opens never create or migrate a database.

The owner masks accepted database operations and waits for their foreign Promises
before closing. It joins database work, not arbitrary application fibers. A host
must stop and join its own readers and runs first. Uncooperative driver calls can
delay shutdown. Failed close after success returns StoreError `WRITE_FAILED` with
the primary Exit and cleanup Causes. Earlier failure retains its Cause with
StoreCleanup diagnostics.

Local owns Kysely transactions, migrations, path locks and SQLite drivers. Reads
share one controlled snapshot across statements. An Effect resource bracket owns the
read connection independently of BEGIN, COMMIT and ROLLBACK, so a failed command still
releases the shared path lock, and a failed commit attempts rollback. Only acquisition and
cleanup are masked; the read itself stays interruptible. Commit or rollback settles
before store release. Node uses DatabaseSync statement finalization. Bun owns and
finalizes every prepared statement before strict close and disables persistent
WAL sidecars so a final writable connection can remove them. A closing writable handle also
tries rollback-journal mode without waiting on other connections, allowing an
immediate standalone readonly copy on macOS. A busy connection keeps WAL mode.
It does not delete sidecars while other connections need them. Libsql remains
the writable fallback.

Resource authoring, registry and cloud operations return Effects. Pure builders,
cURL parsing and reference rewrites remain synchronous. Mutation confirmations
return Effects. Dry runs return before confirmation. Project transactions retain
the loaded-hash commit guard and manifest-last publication. Init verification is
the commit point; later registry failure preserves the verified project. Bounded
input iterators and response readers release after validation failures too.

Cloud requests dispatch once and join accepted foreign work before releasing
ownership. Opaque responses do not prove rollback or authorize replay. Failed
post-publication release reports `project_saved_cleanup_failed` with committed
evidence. Registry and HTTP cleanup keep their own typed failures and primary
failure precedence. Wire formats and full-bundle identity remain owner contracts.

## Executor and runtime

Executor owns invocation, transport deadlines, retries, process trees, sessions,
sandboxes and case environments. Native operations retain attempt evidence as
values; setup and cleanup can fail through tagged errors. `HttpJsonTransport`
returns Effects; guarded fetch remains a foreign Promise boundary.

`applicationStarted` conservatively prohibits replay. Unknown dispatch, header
timeouts and failed cleanup do not authorize another request. Confirmed status
responses retain their retry classification. Streaming 2xx body failure is not
retried. Mapped body observation failure prohibits replay even for polling GETs or
idempotency keys. Late bodies release through their foreign callback and update
the retained receipt.

Stream framing, UTF-8 decoding and terminal extraction stay pure. A streaming
response admits one foreign read at a time; close cancels, joins accepted reads
and releases reader/header resources. Process cleanup carries observation
availability and unreaped identities, so an empty later PID list cannot erase
prior uncertainty. Cleanup errors retain the completed attempt and prohibit retry.

Runtime owns metric evaluation, scheduling and eval lifecycle. The run owner holds
case runners through final hooks and environment release. Persistence and artifact
behavior come from injected interfaces. Defects and mixed Causes propagate after
draining and finalization; ordinary errors retain lifecycle evidence. Failed
persistence or cleanup prevents releasing durable cancellation ownership.

The local eval application owns the CancellationRegistry, store owner and admitted
run fibers. Events do not own run lifetime. Cancellation publication and unregister
are masked and generation checked. A stale poller cannot cancel a newer run.
Uncertain completion detaches polling and retains durable ownership.

## CLI, API and dashboard

Commander actions submit one native program through `CommandContext.submit`.
`run-cli.ts` captures application services at the CLI boundary; `runCli` retains
its process-facing `Promise<number>` API. One process signal reaches prompts and
operations. Ordinary commands interrupt and join their resources. Commands that join
their own work (eval, agent test, metric test, web) pass `{ cancellation: 'owned' }` to
`submit`; the root then maps any failure after the signal to the `cancelled` envelope,
exit 130. Eval uses business cancellation to finish accepted evidence and its terminal
JSONL sequence.

The CLI propagates command failure to the eval application before joining runs.
Signal listeners cover that join and store release. Terminal eval output waits
for application release. An earlier command or infrastructure error keeps its
catalog identity and exit code if release fails. Otherwise release failure replaces
a successful, failed-verdict or cancelled outcome with a catalogued CLI failure.
Completed eval upload failure remains advisory.

API owns contracts, fetch routing, typed client and dashboard bootstrap, without
storage drivers or process policy. RunSource, ProjectCatalog and RunControl
operations return Effects. Dashboard reads include eval pages, trends, case windows,
history, activity and suites. Pure projections stay in core. Hono request roots
apply request signals except to detached run admission. TanStack callbacks execute
client Effects at their declared roots. Opaque mutation failure is not retried.

The local launcher captures cancellation services once and starts detached CLI
processes. Accepted starts outlive the HTTP request. `startViewServer` requires
Scope; close stops admission and joins listener and accepted callbacks before
catalog release. The view command keeps StoreScope outside server lifetime.
Static reports supply no run control. The canonical dashboard command is `attest web`.

## Agent client

Client handlers return Effects. `createAgentRunner` and the Node listener require
Scope. Prefer `withAgentRunner(options, use)` for typed lifetime results. Low-level
scoped constructors retain release receipts; explicitly close before disposal when
shutdown failure must reach the caller's error channel.

Accepted invocations belong to the runner's FiberSet, independently of trigger
request lifetime. Admission allows 64 active handlers and 10,000 retained tokens.
The receipt limit evicts the oldest terminal receipt, never active work. Retained
tokens are not replayed; an evicted token can be admitted as new work.

Shutdown stops admission, signals cooperative cancellation for three seconds,
then interrupts remaining work. Drain observes for 35 seconds; explicit close
interrupts outstanding work. Receipts retain handler, delivery and shutdown Exits.
Completion delivery retries confirmed 5xx up to three attempts with 250 ms and
one-second delays. Opaque rejection, timeout or failed cleanup prohibits replay.
Confirmed 2xx remains delivered even if body release fails. Late responses update
the same receipt. Pi workspace removal joins its filesystem operation. Foreign
Promise interruption alone does not establish remote cancellation.

The root client entry stays Web-standard. `/node` owns HTTP/process integration
and `/pi` owns Pi integration. Browser-safe imports do not establish a hosted
Workers deployment or private host acceptance.

## Verification and security

Keep loopback binding, origin checks, callback tokens, duplicate keys, secret
references, redaction, body limits, pinned destinations and anchored paths.
Portable-source checks are preflight, not sandbox proof. Tests use isolated homes,
projects, stores and loopback port zero, without real credentials or user data.

Run build, typecheck, lint, format and tests after operation changes. Add targeted
invariants for changed cancellation, resource ordering, rollback and cleanup
precedence. Run packed acceptance for local/CLI changes and portability for
executor/runtime changes. Keep tests together in `_tests_`. Document script
changes in SCRIPTS.md and environment changes in ENV.md. Stored data or wire
changes need an explicit migration decision; native operation signatures do not
justify changing their representations.
