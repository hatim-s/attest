# Effect v4 in Attest

This guide governs the native Effect v4 migration. Claude Opus approved the architecture on 2026-11-06. Package ownership remains as documented in ARCHITECTURE.md; each implementation slice requires independent Sol, Claude Opus and Muse review before landing.

## Provenance

Adapted on 2026-11-06 from Hatim's consolidated guide, `/Users/hatim.shakir/.planloft/docs/loopy/loopy-effect-v4-patterns.md`, titled "Loopy Effect v4 coding patterns and architecture". Source SHA-256 at port time is `a2113f0aa664e128fea41f5e95cb6b3c7a31420a2871c30e201c451cadaa9b8b`. That guide identifies its research base as Loopy `33b50f26af0ae6205b5ac123f1e1a898fc9fce78` and supersedes its first proposal.

The retained corpus is `/Users/hatim.shakir/projects/loopy/effect-v4`, a symlink to `effect-v4-evidence-d5e4905`. `ARCHIVE.md` identifies the merged snapshot as `d5e4905340d05e7b4870f1ac5ce51d97b63374ee`. It is an evidence archive, not an active Git checkout. Relevant inputs are:

- `research/effect-v4/sol-sources.md` and `terra-sources.md`, with author pins and version limits.
- `research/effect-v4/deep/modules/findings.md`, for operation construction and transaction ownership.
- `research/effect-v4/deep/lifetimes/findings.md`, for interruption, cleanup and uncertain completion.
- `research/effect-v4/deep/contracts/findings.md`, for schema and transport behavior.
- `research/effect-v4/deep/probes/findings.md` and its installed `node_modules/effect/src`, for exact 4.1.2 signatures and bounded probe evidence.
- `.notes/effect-v4/coordination.md` and `contracts/migration.md`, for implementation lessons. Loopy's old delegation and review policy does not apply to Attest.

The third-party `sources/mattpocock--course-video-manager/docs/EFFECT_STANDARDS.md` is a v3 research input, not Hatim's guide. Matt's sampled code resolves to v3; Julius's gh-file-drop to v4 RC.109; Ben Davis's token-tracker to 4.0.2. They inform design, not 4.1.2 syntax. The consolidated guide reports 16 isolated probe tests and 52 assertions. Those are inherited Loopy evidence, not fresh Attest acceptance.

Target `effect` exactly `4.1.2`. The retained official source identifies [commit 506eef143bcc1750ce58920aac1e45da7265d103](https://github.com/Effect-TS/effect/tree/506eef143bcc1750ce58920aac1e45da7265d103). Installed probe source also reports 4.1.2 but differs in layout from the cached GitHub source. Verify the installed Attest distribution and lock integrity before implementation. Do not infer byte equality from matching versions. Verify peer requirements before adding any platform packages. Do not mix v3 platform packages into v4.

Loopy-specific graph language, atomic apply/outbox, Durable Object leases, daemon architecture and reviewer assignments have been removed. Attest keeps its own contracts, project journal, run records and package boundaries.

## What becomes Effect

An operation that reads files, stores records, invokes an agent, evaluates a remote metric, waits, schedules concurrent work or owns a resource returns `Effect.Effect<A, E, R>`. Expected operational failures belong in `E`. Required services belong in `R` until the composition root supplies them.

Pure case selection, seeded sampling, comparison classification, import transformations, analytics, canonicalization, assertions and result normalization remain synchronous. The I/O coordinator in `diffRuns` becomes Effect; the comparison algorithm does not. Synchronous hashes stay explicit in server-only owners. Do not make every function an Effect to satisfy a search count.

Replace owned async orchestration with generators and native concurrency. `Effect.tryPromise` wraps actual foreign SDK, fetch or driver calls, not an entire old Promise implementation. Delete the replaced path in the same slice. Keep a Promise only at an identified foreign boundary such as Hono, Commander, React's client adapter, the consumer's agent handler or an SDK callback.

## Operation modules and composition

Use Context.Service keys at composition roots for replaceable dependencies such as stores, catalogs and cancellation registries, not for every operation module. Infer the service shape from its constructor using `Effect.Success<typeof makeOperations>` where practical. Contracts that admit host implementations, such as `RunSource`, need explicit operation signatures with concrete error unions.

Capture dependencies once in an `Effect.gen` constructor. Use named `Effect.fn` operations for meaningful operations. Do not add a service per helper, one forwarding class per package, a global service locator or a parallel repository framework.

`Layer.effect(Key, make)` constructs an effectful service and scopes its acquisition. `Layer.succeed(Key, implementation)` supplies an already constructed value. Reuse the same database layer object within the application build. Two objects with one key can open two databases; separate runtime builds also acquire separately. `Layer.fresh` is not a fix for broken provisioning.

The CLI invocation owns one application scope. The local server owns its catalog, opened stores and listener until shutdown. Each evaluation owns worker environments and invocation sessions. Each HTTP request owns response reads and readers, but must not own a detached run admitted by `RunControl.startRun`. The agent client owns accepted invocations until drain/close. Static reports have no run-control layer.

Run Effects only at these entry points in the completed migration. During staging, an unmigrated Promise parent may call an Effect leaf through a lint-ledgered temporary bridge; the reverse direction is forbidden. A managed runtime, when needed for repeated foreign callbacks, has one explicit disposer. Do not call `runPromise` inside an already migrated Effect operation or create a runtime per database method.

## Errors and outcomes

Use `Data.TaggedError("Tag")<Fields>` for internal errors, or `Schema.TaggedError<Self>()("Tag", fields)` when the error itself needs a schema. Use tagged errors for failures that prevent an operation from delivering. Preserve the original cause and safe operation context. A persisted failed case, agent-reported failure, metric score and requested cancellation response remain domain data. They are not automatically Effect failures.

Keep invocation transport failures, metric failures, storage failures, project rejection, cleanup uncertainty and malformed input distinguishable. Preserve existing public error codes through exhaustive edge mappings. Never branch on message strings, use blanket `orDie`, or turn failed reads into missing records, empty lists or successful cancellation.

Broken invariants are defects. Interruption is a runtime cause. User cancellation, deadline expiry and transport disconnect are distinct events, even when all interrupt fibers. Do not translate every interrupted request into a persisted cancelled run.

Retain complete `Cause` information internally. Inspect reason tags and `Cause.hasInterrupts`; do not parse `Cause.pretty`. Define how a primary failure and cleanup failure determine the public result. Preserve invocation evidence and cleanup confirmation alongside that result. Owner tokens, credentials, raw Causes and database details must not enter public JSON or logs.

## Resource ownership and cancellation

Register release immediately after acquisition. Stop and join dependent fibers before closing their process, socket, environment or store. Use `Deferred` for a one-time handshake and `Queue` or generation tracking for repeated completions. Bound concurrency and queues explicitly. Queue capacity does not replace per-test caps, worker affinity or output limits.

The inspected installed signatures distinguish two brackets:

```ts
// Simplified signature shapes, not an additional Attest API.
acquireRelease(acquire, release /* returns Effect<unknown, never, R2> */);
// Acquisition adds Scope to the required environment.
acquireUseRelease(acquire, use, release /* may fail with E3 */);
// Returns Effect<A, E | E2 | E3, R | R2 | R3>.
```

Cleanup follows these rules rather than Effect's default cause combination:

- R1. Ordinary release/finalizer effects have `E = never` and capture cleanup failures, including foreign defects, as owned `CleanupFailure` diagnostics. They never throw or use `orDie`. Store diagnostics in the operation's result or its own Ref, with no global collector.
- R2. Choose the result from the primary Exit and recorded cleanup. A primary typed failure remains the public failure. A primary interruption remains interruption. Both retain cleanup diagnostics internally. After primary success, cleanup failure becomes the operation's typed error carrying success evidence, or explicit domain flags. Examples are `project_saved_cleanup_failed` with `committed: true` and transaction identity, or false cleanup/completion/ownership-release flags. A store close failure after a successful read still fails the operation.
- R3. Primary defects stay defects. Edges map them to the internal error code and retain a redacted Cause. Inspect reason tags and `Cause.hasInterrupts`, never rendered Cause text. Capturing a cleanup defect must not turn a primary defect into success.

Project rollback is a compensating durable mutation. If rollback or its journal cleanup fails after a typed transaction failure, return `project_recovery_required` with the transaction identity and retain both Causes internally. After confirmed restoration, preserve a domain error or map foreign failures to `project_transaction_failed` with the restored-state message and transaction identity. Primary defects and interruption keep their runtime Cause. Ordinary descriptor and lock releases still follow R1 through R3 above.

A fallible `acquireUseRelease` release is permitted only when it inspects the primary Exit and can fail solely after primary success, such as post-commit project cleanup. Otherwise use R1. Register cleanup immediately after acquisition and attempt every required cleanup step.

Bound uncooperative foreign cleanup with `Effect.timeoutOption(Effect.interruptible(cleanup), bound)` inside masked release. Capture its entire outcome into diagnostics. A timeout means cleanup is unconfirmed; it does not prove a process or sandbox stopped. Preserve process-tree termination, signal grace and descendant verification. Never reuse an environment with unconfirmed cleanup.

Cancellation and deadlines are business inputs. Represent each request as an `Effect<void>` backed by a Deferred. The owner keeps resources in an outer bracket, races only observation against cancellation/deadline, performs kill or close in normal flow, then returns cancelled or timeout evidence. `Effect.timeout`, `timeoutOption` and `raceFirst` must not surround operations that produce attempt, metric or case evidence. They may bound pure waits or cleanup. Observation must not interrupt a sibling case or discard its eventual evidence.

Reserve fiber interruption for teardown and shutdown. The first CLI SIGINT/SIGTERM completes business cancellation instead of interrupting the application root. Preserve once-only listeners so a second signal can terminate the process. Foreign SDKs receive the signal allocated by `tryPromise` with an ordinary declared `(signal) => ...` parameter, not rest/default parameters. Consume response bodies in the cancellable foreign operation. Remove owned AbortSignal.any composition and its retention helper only when the last consumer migrates, and update the architecture note in that slice.

`tryPromise` aborts and resumes on interruption without joining the foreign Promise. It does not prove completion or rollback. Reconcile uncertain writes by identity before any allowed retry.

Eval registry release uses the run's Exit. Unregister only when `Exit.isSuccess(exit)` and `exit.value.can_release_cancellation_ownership` are true, with the matching generation. Otherwise detach the poller and retain ownership evidence. Acquire the store before publishing the registry so registry release runs before store closure. Cancellation acknowledgement means requested, not stopped. Keep cancellation requests scoped to the run, never signal arbitrary work by PID alone.

The eval run forks into the CLI application scope with `forkIn`, not as a child of the action that returns its event queue. Join it before root disposal. A process-root CancellationRegistry service replaces the module-global controller map. Its run-local poller uses `forkScoped` with a 25 ms spaced schedule. Client invocations live in a runner-owned FiberSet, never the triggering request. Closing signals cancellation, allows bounded completion delivery/drain, then interrupts remaining work.

Detached dashboard admission is not tied to the HTTP request signal. It is uninterruptible but bounded by the existing start timeout plus stop grace. Preserve kill-tree verification and report an unconfirmed child explicitly. Never retry admission automatically. A new client request has a new run identity.

## Persistence and project transactions

Core owns native Effect storage contracts. Methods capture dependencies at construction and return Effect with `R = never`. Remove `close()` from RunStore and AttestStore; scoped constructors own closure. ProjectCatalog owns its opened readonly stores, and openProject exposes no Scope requirement. Do not cache failed opens. If RcMap is used, prove failed-open eviction with a gated test. Local owns SQLite/Kysely/libsql adapters, migrations, driver choice and closure. Retain readonly opens with no creating fallback. Keep row validation and transactional writes at the adapter boundary.

Inspect each driver's transaction contract separately. A synchronous SQL callback must finish synchronous SQL before returning; returning an Effect does not run it in the transaction. Wrap that whole foreign operation once. An asynchronous libsql/Kysely transaction must commit or roll back before releasing its connection. Do not copy Loopy's synchronous driver recipe onto all Attest drivers. Do not nest a runtime inside a transaction callback.

Store mutations wrap the complete Kysely transaction Promise in Effect.uninterruptible so a transaction cannot outlive handle closure. Its callback remains Kysely code, with no nested Effect runtime. Preserve StoreError and map other failures to WRITE_FAILED. Reads may remain interruptible. Registry publication/unregister and project journal commits are also uninterruptible.

Keep network calls and notification publication outside a database transaction. Preserve atomic case recording and aggregate updates. A lost commit acknowledgement is uncertain, not proof of rollback. Only recordCase may replay identical input bytes through its existing hash check. Preserve same-status finalize acknowledgement; never blindly retry createRun or finalizeRun.

Project changes retain lock ownership, expected-hash checking, staged journals, path rechecks, fsync and manifest-last publication. Dry-run remains write-free, including lock creation and journal recovery. Preserve the distinction between rolled-back failure, recovery required, and `project_saved_cleanup_failed` with `committed: true`. Do not repeat the mutation when only cleanup failed.

## Schema and wire policy

Use native Effect Schema as the owner and infer decoded/encoded types. No Zod-shaped facade and no permanent duplicate schema declarations. Convert all callers of an owned schema in the same compiling slice, including JSON Schema generation, CLI inputs, SQL rows and browser bootstrap consumers.

Export the contracts-owned decoder publicly from @attest/contracts in Result, Effect-error and synchronous throwing forms. These are the supported decoders for Attest schemas, including external consumers. The web router uses the sync-throwing form. S1.0 introduces these forms over the existing Zod owner with no behavior change; S1a replaces the implementation with native Effect Schema. Validate unknown input once through this owner and options `{ onExcessProperty: "error", errors: "all" }`. Ban direct Schema decode calls elsewhere by lint, except explicitly owned synchronous throwing edges routed through that decoder. Preserve public Attest Result and ParseReport pure-parser shapes; native Effect Result remains internal. Effect operations fail through E rather than returning the public Result envelope.

Contracts owns three struct constructors. Strict uses Schema.Struct. Loose uses StructWithRest with a string-to-unknown record to preserve extra keys. Strip decodes the loose representation into a plain struct, dropping extras. Map existing strict/loose/strip schemas one for one, including nested combinations. A tightening is a behavior change, never an incidental migration default. Prove these constructors against the installed 4.1.2 distribution before converting owners.

Map Zod optional to Schema.optional by default, preserving explicit undefined. Use optionalKey only when key presence matters. Preserve Object.hasOwn-based outcome rules. Accept readonly decoded types explicitly and rewrite mutation sites to construct values; parameters accept readonly arrays. Use mutableKey only where a foreign API requires mutation. Audit defaults, null, coercion, finite/integer checks, recursive JSON and refinements.

Replace the issue formatter with SchemaIssue formatting based on makeFormatterStandardSchemaV1 paths. Preserve `$` for root, dot joins and one issue path per unexpected key. Multi-path refinements use makeFilter returning path/issue arrays; agent-request fixture 04 must still report both turn_index and conversation_id. Authored refinement messages stay identical. Built-in display messages may change, with no message-based branching. Unknown-field warnings read the inner struct fields, and invalid optional trace still degrades to warnings.

Preserve protocol identifiers, public codes, field names, canonical hashes, project identity, selection counts, exactly-one output/error, callback trace/trace_ref exclusion and cursor semantics. Keep internal `_tag` out of public envelopes. Canonical bytes after decoding must match base fixtures.

Generate with toJsonSchemaDocument using `onExcessProperty: "error"`. Assemble dialect, root schema and definitions as `$defs` before existing invariant overlays. Keep Draft 2020-12, filenames, `$id` and overlay comments. Compare accepted/rejected fixture verdicts under AJV using both old and new artifacts as S1a evidence. The permanent exact generated-content check remains. Keyword placement, definitions names and equivalent representation may change; changed validation verdicts, lost required/excess-property rules or loosened constraints must be restored with annotations/overlays. No unreviewed wire break is permitted. AJV remains for user-supplied JSON Schema metrics.

S1.0 first centralizes schema decoding while still on Zod without changing behavior. S1a swaps the shared schema/composition closure atomically. S1b migrates private schemas per package. Check installed TanStack AI types before replacing the judge schema: use Effect-derived JSON Schema/Standard Schema if supported; otherwise retain its single Zod schema as a documented foreign SDK owner, with no duplicate schema. Web router params retain intentional synchronous throws through the decode owner, and validateSearch uses Standard Schema with explicit catch-to-default parity.

Public TypeScript operation APIs intentionally change to Effect. Update all repository consumers and document the break. Persisted data and agent/cloud wire formats need a concrete migration decision before changing. Backward compatibility shims are not the default.

## HTTP, streams and portability

Keep Hono and Commander at the first migration boundary. Native operations do not require replacing the web framework or CLI parser. Do not adopt HttpApi in this migration. Hono handlers run native operations with the request signal, except detached admission. The CLI owns one ManagedRuntime with one disposer.

Stream adapters retain incremental framing across arbitrary chunks, UTF-8 handling, caps, deadlines, terminal rules and raw evidence hashes. Scope reader cancellation and socket/session closure. Preserve event ordering, configured versus completion indices and run terminal event precedence. A Stream conversion does not itself prove backpressure, reconnect or delivery semantics.

Keep `@attest/core/records`, `/analytics`, API `/contract` and `/client` browser safe. `@attest/client` root remains Web-standard and imports no Node code or evaluator runtime; `/node` and `/pi` own process integration. Executor `/http` must not eagerly load process or sandbox implementations. Its documented hosted use still requires `nodejs_compat`.

Allow core `effect` imports only. Ban platform subpaths `effect/http`, `http-api`, `sql`, `process`, `cli`, `rpc`, `socket`, `cluster`, `workflow`, `ai`, `persistence` and `workers`. Only data-only entries core/records, core/analytics and api/contract are restricted to effect, effect/Schema, effect/SchemaIssue, effect/SchemaAST and effect/JsonSchema, plus explicitly documented core modules proven necessary by S0. api/client, web and the client root may import portable core Effect modules. All browser entries ban platform subpaths and Node built-ins. Record bundle sizes at S1a, S9a and S9c.

Track permanent execution roots in the `effectRoots` ESLint block and temporary forward bridges in `effectMigrationBridges`. Ban Effect.run* and ManagedRuntime.make elsewhere. Every temporary bridge carries an adjacent EFFECT-BRIDGE(Sx) tag and a ledger owner/removal slice. The lint-rules gate checks tags against listed files in both directions. S10 removes the temporary block and the typecheck-only tools/effect-probe workspace.

Server packages support Node 22.15+ and Bun 1.4+. Choose portable core Effect APIs first. Do not add Bun-only SQL/process implementations as defaults for Node. S0 measures node:sqlite import support, readonly opening of an existing fixture and rejection of a missing fixture without creating it on Bun 1.4; retain the explicit readonly error if unsupported. Keep Kysely, node:sqlite and libsql rather than switching SQL drivers. Existing process support does not become Worker-compatible through Effect. S1a records web bundle size before/after and updates the client dependency documentation from Zod to Effect. S9c measures the Workers client bundle. The native client handler and request APIs return Effect; actual host callbacks remain foreign Promise boundaries. Browser builds catch platform imports.

## Security and validation

Retain loopback binding, origin checks, callback tokens and duplicate admission keys, secret-reference resolution, redaction, bounded bodies/artifacts, pinned HTTP destinations and host-owned DNS/tenant policy. Retain path anchoring and symlink defenses, isolated child environments and argv-based hooks. Portable-source static checks remain preflight, never sandbox proof. Cloud full-bundle identity includes source bytes; local manifest hash does not substitute for revision identity.

Use isolated temporary projects, homes, stores and loopback port 0. Never use personal registries, real credentials, production databases, providers or deployments as migration fixtures. Mock evidence is not hosted acceptance.

Each slice must compile with its callers, satisfy lint/format and pass owned invariant tests. Test resource ordering, cancellation, rollback, schema conversion and durable uncertainty where they can fail. Keep tests in `_tests_`; avoid forwarding-wrapper tests. Run the root build, typecheck, lint, format and tests, plus affected schema, portability and CLI acceptance gates. Update `docs/SCRIPTS.md` for script changes and `docs/ENV.md` for environment or binding changes.

Before implementation, Claude Opus must approve the architecture. Every implemented slice then needs separate Sol, Claude Opus and OpenCode Muse Spark 1.3 Contributor approvals on a frozen exact diff. Any fix invalidates affected approvals until re-reviewed. No merge onto main with missing approval. Reviewer availability must be verified without substituting models silently. The local `PLAN.md` records ownership, gates and open decisions.

## S0 tooling ownership

`tools/effect-probe/src/probe.ts` is a typecheck-only consumer of exactly Effect
4.1.2. S10 deletes the workspace, root probe script and dependency entries. It does
not execute effects and needs no execution exception. No production roots or
bridges are declared in S0.

The local `effect-boundaries` lint rule freezes the installed root module export
list as its core allowlist. Nested and platform subpaths are rejected. Data-only
entries use exactly Schema, SchemaIssue, SchemaAST and JsonSchema, including named
imports from the root. No additional data modules were needed. Execution method
references, including named imports and aliases, require a declared operation in
an exact-file root or bridge entry. Namespace escapes and dynamic Effect loading
are rejected to keep ownership visible. Bridge entries carry `file`, `operations`, `owner` and a `bridges` list of
`{ operation, removalSlice, owner }` associations. One exact-file config block
preserves every association when a file has multiple removal owners. For example,
project-registry reads end in S2 and writes end in S8c. Each execution reference
needs an adjacent real `EFFECT-BRIDGE(Sx)` comment matching its operation's declared
association. Removal slices are limited to the approved migration plan; stale and
duplicate associations fail lint. The legacy single `removalSlice` rule option
remains covered by lint tests, but new ledger entries use associations. The lint-rules gate checks config routing, declaration
files, stale operations and unmatched tags. Neither tests nor browser entries get
a general execution exception.

Execution ownership also covers Runtime.makeRunMain, FiberSet/FiberMap/FiberHandle runtime and runtimePromise, and Stream.toReadableStream* / toAsyncIterable*. These APIs require exact operation ledger entries just like Effect.run*. A root keeps its ManagedRuntime value in its own file and never passes it to other modules; the lint rule does not track runtime instance methods across module boundaries.

## Public native decoder, S1a

`@attest/contracts` exports `parseWithSchema(schema, candidate)` returning the
public Attest `Result`, `parseWithSchemaEffect(schema, candidate)` returning a
native `Effect` with validation failures in E, and
`parseWithSchemaSync(schema, candidate)` for intentional synchronous throws.
Output types follow the schema, including transforms and generic schemas.
External consumers, including the future attest-cloud migration, must use these
exports instead of invoking schema parsing methods. No private repository was changed.

S1a replaces the former Zod definitions with native Effect Schema. This intentionally
breaks the public TypeScript schema API: infer decoded types with `typeof schema.Type`
and encoded types with `typeof schema.Encoded`. Decoded collections are readonly.
All three decoder forms use `SchemaDecodeError`, carrying the native SchemaError as
its cause and readonly issues with native structural tags, PropertyKey paths and
messages. Authored messages and public protocol paths remain; built-in wording and
union branch diagnostic multiplicity change. Consumers must not inspect Zod trees
or branch on messages. No stored-data migration is required.

The Effect form is suspended and fails with SchemaDecodeError in E. The synchronous
forms use the declared contracts decoder root. Thrown user refinements remain defects
in Effect and throw their original cause at synchronous boundaries. Existing protocol
parsers retain ContractIssue[] and ParseReport warning shapes through formatContractIssues.
Nested strict, loose and strip policies share error/all decoding; defaults and catch
behavior remain schema-owned. Manifest and reference invariants share pure checks
rather than decoding the same manifest again inside a parent refinement.

Typed lint rejects native Schema/SchemaParser decoder references and Schema.is/asserts
outside the owner. The temporary typecheck-only tools/effect-probe/src/probe.ts
also retains its direct upstream signature checks until S10 deletes it. No other
probe or test file receives this exception. Schema.decodeTo transformations and foreign Standard Schema adapters
remain allowed. Legacy Zod execution is also rejected. The intrinsic JSON guard in
project/shared.ts remains an owner exception. JSON, Date, Commander and router parsers
are unrelated and remain permitted. Reference checks do not track erased any or
arbitrary interprocedural data flow.

External attest-cloud consumers must migrate shared schema reflection and decoder
errors with S1a. Its later store, executor, metrics, runtime and API operation changes
remain separate slices. No private repository or hosted runtime was changed or verified.

Platform and companion `@effect/*` imports require an architecture decision.
Computed import and require paths are banned repo-wide so lint can check import
boundaries. Literal imports of non-Effect modules remain permitted subject to
existing package restrictions. This is the explicit policy for the existing
fail-closed dynamic-loading rule.

## Native schema construction imports

Two data-only files need additional portable construction modules in S1a.
Core records/page-schemas.ts uses effect/Effect for a schema default.
API contract/requests.ts uses effect/Effect for defaults and effect/SchemaGetter
for HTTP number coercion. ESLint allows these modules only in those exact files;
execution APIs still require a declared root. Other data-only files retain the
Schema, SchemaIssue, SchemaAST and JsonSchema allowlist.

### Concrete store lifetime owner

`@attest/local/store` exports `withStoreScope(use)`, `openStore(path, owner)` and
`openReadonlyRunStore(path, owner)`, plus the opaque `StoreScope` type. The owner is
created only by `withStoreScope`. Constructors capture that exact owner, require no
ambient Scope and return `Effect<AttestStore, StoreError>` or
`Effect<RunStore, StoreError>`. Store and catalog methods have `R = never`.
RunControl remains Promise-based until S9a. There is no public store `close()`.

A short CLI operation encloses all store work:

```ts
const program = withStoreScope((owner) =>
  Effect.gen(function* () {
    const store = yield* openStore(path, owner);
    return yield* store.runs.listRuns();
  }),
);
```

A server catalog captures the owner inside this callback and keeps the callback
running until server shutdown has stopped admission and joined readers and runs.
An eval owner awaits actual engine completion and persistence before returning,
even if a foreign action has already received an event queue. Returning a listener,
catalog or queue from the callback closes its stores. Escaped methods then fail.
The foreign execution root runs the complete program once and checks its Exit.

Within one owner, repeated successful opens of the same resolved path share one
run/cache handle. Mixing readonly and writable opens for that path fails explicitly.
Different owners acquire separately. Failed acquisition closes immediately and is
not cached. Readonly opens never create or migrate the database and never fall back
to a creating driver.

The owner masks accepted store operations, including reads, and waits for their
foreign Promises before closing. Consequently an uncooperative read or write can
delay shutdown until it settles. New operations and acquisitions fail once shutdown
begins. Owners must stop admitting application work and join their run/request fibers;
the store owner joins accepted database work, not arbitrary application fibers.

Finalizers capture every close outcome in an owner-local receipt. After success,
failed release returns StoreError WRITE_FAILED with the successful primary Exit and
all cleanup Causes in its internal cause. After typed failure, defect or interruption,
the original Cause remains primary and the StoreCleanup annotation retains cleanup
Causes. Never serialize these internal diagnostics into public responses. A close
failure does not authorize retrying a successful mutation. The complete S2 still
requires caller integration, full gates and independent reviews before commit.

## Native executor operations

The dispatch, CLI/HTTP attempts, shared retry, mapped HTTP execution/polling, JSON
transport, DNS/pinned header acquisition and process-tree operations return native
Effects. Attempt failures retain their bounded evidence as values. CLI setup and
cleanup can additionally fail with closed tagged errors; cleanup after a completed
attempt retains that attempt. Dispatch propagates those channels and the contracts
decoder error instead of classifying them as retryable transport failures.

`HttpJsonTransport` is now an Effect-returning host contract. `GuardedHttpFetch`
remains a foreign Promise boundary. Host transports must distinguish known
pre-dispatch failures from unknown dispatch honestly. `applicationStarted` is a
conservative replay prohibition, not proof that a server executed a request. A
header timeout, opaque rejection or failed local cleanup cannot authorize another
request when completion is unknown. Confirmed status responses retain their
existing retry classification. See the HTTP rules in `specs/agent-contract.md`.

Header and body observers have bounded cleanup. An uncooperative guarded fetch
can settle after the native owner returns; its foreign callback releases a late
body and updates the retained internal receipt without starting another Effect
runtime. Missing or failed acknowledgement remains unconfirmed. Local socket
close is resource evidence, not proof of remote completion or rollback.

S4a removes `legacy-stream-fetch.ts` and the callback and stream execution bridges.
Managed-process callers retain their S4c removal owner; they
do not turn native JSON operations back into Promises.
The sandbox attempt and retry callback compose natively while its surrounding VM
lifecycle remains the S5 owner. No S3 execution bridge remains.

Process observations return `{ identities, available }`; sweeps return
`{ unreapedProcessIds, cleanupConfirmed }`. Pass earlier observation availability
into the sweep. Losing an observation before reparenting cannot be repaired by an
empty later PID list. CLI retains successful or failed attempt evidence in
`CliCleanupError` when cleanup is unconfirmed, so the retry loop never starts a
second attempt. Hook and managed-process callers retain the same confirmation bit.
These result shapes are deliberate TypeScript API changes. The local invocation
boundary projects a `CliCleanupError` with an attempt into failed case evidence,
retaining its diagnostics, excerpt, duration and original failure code. A completed
attempt becomes a network failure with an explicit cleanup message. This boundary
does not retry it. Managed sessions mark automatic close promises handled as soon
as teardown starts; `close()` still returns the original rejection to the owner.
Startup cancellation and readiness errors remain primary if teardown also fails.

Direct HTTP status errors retain an already-errored body's rejected cancellation
as internal evidence without prohibiting status retries. A cancellation timeout or
interruption still prohibits replay. Mapped body observers remain conservative:
a failed body observation prevents replay even with a retryable status, an
idempotency key, or a polling GET. Integration guides describe this limit.

```mermaid
flowchart TD
  A[CLI terminal observation] --> B[Join snapshots]
  B --> C[Identity-checked process sweep]
  C --> D[Observe close and detach listeners]
  D --> E{Primary Exit}
  E -->|Failure or interruption| F[Keep primary Cause and attach cleanup evidence]
  E -->|Attempt completed| G{Cleanup confirmed?}
  G -->|No| H[Fail with attempt retained; no retry]
  G -->|Yes| I[Return attempt to retry classifier]
```

```mermaid
flowchart TD
  A[Acquire HTTP headers] --> B{Headers received?}
  B -->|No| C[Bounded cleanup; retain late-response receipt]
  B -->|Yes| D[Transfer response to body or status owner]
  D --> E[Capture body and release outcomes]
  E --> F[Keep primary evidence and cleanup diagnostics]
  F --> G{Dispatch or cleanup uncertain?}
  G -->|Yes| H[Prohibit replay]
  G -->|No| I[Apply status and envelope retry rules]
```

## Stream and callback ownership

`invokeStreamingAgent`, `invokeCallbackAgent`, `triggerCallbackAgent` and
`completeCallbackAgent` return native Effects. Stream framing, UTF-8 decoding,
terminal extraction and evidence formatting remain pure. `StreamHttpTransport`
returns an Effect of a single-consumer response with `read` and `close` Effects.
Each read admits one foreign read; close cancels the body, joins accepted reads
and releases its reader/header resources. A cancellation notification alone does
not confirm cleanup. Bounded observations retain uncertainty and prohibit replay.
`createFetchHttpTransports` remains a pure constructor around a foreign guarded
fetch; its JSON operation is unchanged. There is no legacy stream execution bridge.

S4a also changes stream retry behavior: a body failure after successful 2xx
headers is never retried, even before the first event. Receiving headers proves
the request reached the agent; a reset or idle timeout does not prove its work
stopped. Header acquisition is masked during teardown and may wait for the
configured connect and first-byte deadlines before release.

```mermaid
flowchart TD
  A[Acquire stream headers] --> B[Read loop with deadline and cancellation observations]
  B --> C[Capture terminal evidence or primary failure]
  C --> D[Cancel body and join accepted read]
  D --> E[Release reader lock and headers]
  E --> F[Select result with cleanup evidence; no replay after 2xx headers]
```

`createLoopbackCompletionReceiver` requires a Scope. Its register, completion,
release and close operations are native Effects. Keep that scope for the whole
session, including every admitted invocation. The receiver starts its listener
lazily, serializes startup and idle shutdown, and uses scoped workers to consume
Node request observations. Node callbacks publish to a bounded queue; they do not
execute Effects. Close is terminal and retains its first Exit. The scope fallback
captures cleanup instead of throwing; the concrete receiver's `cleanup` Effect
observes that retained Exit after scope disposal. Hosts should explicitly close
and inspect failure before disposing the scope.

```mermaid
flowchart TD
  A[Register under lock and lazily listen] --> B[Node request callback]
  B --> C[Bounded queue]
  C --> D[Scoped worker validates and handles request]
  D --> E[Deliver completion and release registration]
  E --> F[Idle listener shutdown]
  A --> G[Terminal close]
  G --> H[Stop admission, settle entries, join workers and listener]
```

The temporary local S7b owner stops admission, joins accepted invocation Exits,
then closes the receiver and its retained scope. Construction failure closes the
scope with its actual Exit. Scope disposal cannot replace a primary failure.
`CallbackCleanupError` retains a full completed invocation if registration or
signal cleanup fails. `StreamCleanupError` does the same for outer stream signal
cleanup; per-attempt cleanup retains terminal diagnostics, excerpts and warnings.
Local recording preserves earlier attempts, diagnostics, excerpt, duration and
warnings while marking the terminal attempt failed. Defects
remain defects. These are deliberate TypeScript API changes; callback wire
messages and persisted case formats do not change. Hosted custom receivers and
stream transports must implement the native contracts. Private attest-cloud and
workerd compatibility are not established by the local Node/Bun checks.

### Native WebSocket sessions, S4b

`startWebSocketAgent` now returns an Effect requiring Scope. Session `invoke` and
`close` return Effects; invalid templated URLs fail in E when evaluated instead of
throwing during construction. This is a deliberate TypeScript API break. Use
`withWebSocketAgent(agent, options, use)` to keep the session alive for the whole
operation and apply primary-Cause precedence after release. Lower-level scoped
owners call `close` explicitly and inspect its Exit; `releaseExit()` also retains
the scope fallback release receipt. Close stops admission and joins accepted
invocations before its owner releases the acquisition scope.

Only opening failures known to precede application dispatch can retry. Each such
failure retains its own attempt evidence. A socket write prohibits replay even
without an acknowledgement, and rejected upgrade responses prohibit retry while
bounded resource release is observed. This narrows the authored
`before_acknowledgement` ceiling. The existing acknowledgement evidence fields
still describe that authored ceiling; `applicationStarted` on failures records the
stricter runtime prohibition and does not prove remote execution. Wire schemas,
protocol IDs, canonical hashes and public error codes remain unchanged.

A per-case close failure returns `WebSocketCleanupError` retaining the completed
`InvocationResult` and cleanup Cause. Primary failures, defects and interruption
retain their Cause with cleanup annotations. The S7b local forward boundary keeps
a Scope across Promise calls, stops admission, joins those calls, then disposes
the scope. Its known cleanup-error projection preserves previous attempts and
terminal diagnostics, excerpts and warnings without replay. Callback, stream and
process lifetimes remain owned by their separate migration slices.

WebSocket admission installs its completion finalizer while masked, then restores
interruption for invocation. Every drain wait detaches its listeners on success,
close, cancellation and native interruption. Opening failures keep their full
Cause as a non-enumerable internal receipt on the recorded error, including when
a case deadline settled first. Each invocation owns its recorded error and last
attempt; a shared run failure is never mutated to attach a sibling's receipt.
Native interruption remembers the abandoned request ID in the bounded ignored
set, so a late reply cannot fail healthy siblings on the shared connection.
Nested cleanup appends every release failure.
The upgrade's dispatch evidence prohibits replay regardless of which timer wins.
A per-case cancellation after opening still uses the existing unclean-close
policy and may report `close_timeout` after attest destroys the socket; refining
that classification remains follow-up work.

```mermaid
sequenceDiagram
    participant Owner
    participant Session
    participant Transport
    Owner->>Session: Acquire in Scope
    Owner->>Session: Invoke
    Session->>Session: Admit and register join while masked
    Session->>Transport: Open and send with interruption restored
    Transport-->>Session: Terminal evidence and opening Cause
    Session->>Transport: Bounded release
    Session-->>Owner: Result or primary Cause with cleanup
    Owner->>Session: Close
    Session->>Session: Stop admission and join accepted calls
    Session-->>Owner: Memoized release Exit
    Owner->>Session: Release Scope
```

```mermaid
flowchart TD
    Open[Observe opening Exit] --> Native{Defect or interruption?}
    Native -->|Yes| Cause[Propagate original Cause]
    Native -->|No| Evidence[Keep typed error and cleanup receipt]
    Evidence --> Unsafe{Dispatch uncertain or release unconfirmed?}
    Unsafe -->|Yes| Stop[Record without replay]
    Unsafe -->|No| Retry{Retryable code and budget remain?}
    Retry -->|Yes| Backoff[Wait with caller cancellation]
    Backoff --> Open
    Retry -->|No| Stop
```

## S4c managed process sessions

`startBackgroundAgent` and `startJsonlBridgeAgent` now return native Effects requiring
`Scope.Scope`. Their `invoke` and `close` operations return Effects. This is a deliberate
TypeScript API break. Retain the scope for the entire run and explicitly yield `close()`
to observe cleanup confirmation. The scope finalizer captures the same memoized cleanup
Exit; `cleanupExits` remains owned by the session and repeated close observes the original
outcome without another process sweep.

JSONL framing runs in a scoped worker. Request admission and each frame queue are bounded
at 256. Overflow refuses new work or ends the session with `output_cap_exceeded`; it never
replays a possibly dispatched request. Cancellation and deadlines first request in-band
cancellation. Interruption joins acknowledgement or fallback before releasing the observer.
Fallback stops admission, interrupts protocol workers and verifies the owned process tree.
The original automatic-close rejection is retained as a Deferred Exit, with no detached
rejected Promise. Cleanup errors retain the last completed invocation, including its earlier
attempts, in `ProcessCleanupError.completed`. Background close stops admission, requests
cancellation of active HTTP observations and joins them before shutdown and process cleanup.

Readiness races only observations. Readiness socket/listener releases and response body
cancellation retain their full Exits; unconfirmed readiness body cleanup stops startup.
Authored background shutdown remains best effort, with its outcome retained separately from
mandatory process cleanup. ManagedChild captures snapshot, tree sweep and direct-child close
outcomes. A snapshot failure cannot skip the sweep, and an unconfirmed close forbids reuse.
Primary startup failures, defects and interruption retain their Cause with cleanup annotation.

Local's `process-session.ts` is the temporary S7b forward boundary. Its Promise run owner
retains a native Scope through all invocations and disposes it only on close. The three S4c
execution bridges are removed. The integrated WebSocket and callback/stream owners remain
native. Shared Promise helpers with later-slice consumers remain outside S4c.

## S5 native case environments

`CaseEnvironmentFactory` now returns `Effect<CaseEnvironment, Error>` and each
`CaseEnvironment` operation returns an Effect. `metricSandboxIsolation` returns an
Effect with an optional environment. `invokeVercelSandboxAgent` and sandbox file
transfers also return Effects. These are deliberate TypeScript API breaks; execute
operations at the owning root. Wire formats, public invocation codes, and hashes
are unchanged. Factories transfer an explicit lifetime to the caller, which must
run `beginFinalization`, final hooks, and `dispose` in that order.

Operations admit work when their Effect runs. Finalization closes run admission,
aborts and drains admitted work, then opens a separate bounded final-hook phase.
Native fiber cancellation becomes an operation signal and waits for the owned Exit;
its Cause retains completed evidence. VM commands that reject poison the environment
and stop it at most once. An unconfirmed stop or drain rejects disposal and forbids
reuse. Late creation after cancellation is stopped before ownership can transfer.
No deadline races an evidence-producing command and then redispatches it.

Release failures retain the primary Cause through cleanup annotations. A successful
operation followed by release failure yields `EnvironmentCleanupError` with the
completed value. Sandbox invocation retains completed attempts and raw evidence
when projecting artifact or VM-stop failure into invocation diagnostics. The
original command error now remains primary when both command and stop fail, with
the stop Cause attached internally; older callers expecting an AggregateError for
that combination must consume the original Error instead. Runtime Promise callers
use declared S7a forward bridges; metric transports now compose environment Effects directly.

## S6 native metrics

Executable and aggregate metric evaluation, command transports, judge clients and judge caches
return native Effects. Assertions, evaluation documents, JSON decoding algorithms, scoring and
canonical cache hashes remain synchronous. This is an intentional TypeScript API break, with no
Promise facade. Case environments use the S5 native contract directly.

Metric cancellation signals and deadlines remain evidence inputs. Native interruption signals the
resource owner and joins its Exit before propagating interruption. Process cleanup is memoized;
stdout and stderr remain bounded. HTTP readers cancel live streams and always release their
lock. After a read rejects, the stream is already errored; cancel would repeat the same error,
so the transport records the read failure and continues evaluating later metrics.
Every required release is attempted and its Exit retained. Primary failures, defects and interruption
keep their Cause and cleanup annotations. Cleanup failure after successful work fails with a
MetricCleanupError carrying completed evidence. It cannot become a scored failure.

The local judge adapter composes S2 CacheStore operations directly. In-flight identical calls
share a Deferred only within the same cache, client, signal and timeout scope. The owner publishes
its complete Exit as data after removing the slot. A waiter interrupted by its own caller stops
waiting; an uninterrupted waiter whose owner was interrupted acquires a new call only when the
owner's cleanup succeeded. Failed cleanup, including a joined operation's retained Exit, propagates
without another provider call. Environment failures retain executor-owned cleanup receipts through
both transport and aggregate evaluation; later metrics do not run after unconfirmed VM cleanup.
Typed advisory cache write failures do not invalidate
a completed verdict; defects and interruption still propagate. TanStack structured output retains
the strict verdict decoder and exactly one malformed-output retry.

The remaining Promise eval caller bridges metric evaluation under S7b; the metric command caller
uses S8b. Agent configuration bridges native secret resolution under S7b. These bridges retain
full Causes at the existing valueFromExit boundary. Runtime scheduler and application lifetimes
remain for S7 and later slices. This snapshot includes the independently approved S5 r3 resource
repairs; combined integration and later slices remain pending.

Aggregate metric evaluation preserves environment and metric cleanup failures, including their
completed evidence, and stops before the next metric. A mixed Cause containing a defect or
interruption never enters judge retry classification. Cleanup annotations retain every primary
branch's release evidence before appending outer cleanup. Secret reads discard a successfully
read value if closing its descriptor fails; only the cleanup Cause enters the error chain because
failed resolution cannot register that value for redaction.

```mermaid
flowchart TD
  A[Case metrics in definition order] --> B[Assertion, executable transport or judge]
  B --> C{Native Exit}
  C -->|Operational metric result| D[Record evaluation and advance]
  C -->|Cleanup failure, defect or interruption| E[Preserve full Cause and stop]
  B --> F[Judge cache and matching in-flight call]
  F --> G{Owner Exit shared as data}
  G -->|Success| H[Cache verdict and recalculate threshold]
  G -->|Owner interrupted, waiter still active| F
  G -->|Failure or defect| E
```

## S7a native eval runtime

`executeResolvedEvalPlan` returns `Effect<EvalExecutionResult<Payload, BaselineDiff>, Error>`.
The runner, stage callbacks, hooks, persistence, baseline, artifact writer and event sink
all return native Effects with captured dependencies and no remaining environment.
This is a deliberate TypeScript API break. Local and CLI conversion is S7 phase B;
Promise callers must compose the native operations at their owning application root.
There is no reverse Promise adapter in runtime.

Case scheduling uses scoped fibers and a completion Queue. Settlement order is captured
before the ordered persistence sink. Slots refill before persistence, with per-test caps
and worker directory affinity preserved. Every accepted case is joined, including when
a sibling defects. Caller cancellation and run deadlines abort the signal consumed by
evidence owners; neither races case recording. Native interruption requests abort and
joins the run, its case writes, cleanup and finalization before returning interruption.

Every final case hook and environment release is observed. Ordinary operational errors
retain the existing infrastructure and lifecycle evidence. Defects and mixed Causes
propagate after draining and finalization. Internal Cause annotations and non-enumerable
receipts retain primary failures, release failures and completed evidence without changing
wire messages, store shapes or hashes. Failed persistence or cleanup prohibits releasing
cancellation ownership, even when a later reconciliation succeeds. No library runtime is
created and no `run*` execution bridge remains in the runtime eval owner.

## S7 local B1 native adapters

Local agent resolution, invocation, sessions, eval hooks, metrics and persistence
compose Effects directly. `createEvalCaseRunner` now acquires a runner as
`Effect<EvalCaseRunner<ResolvedEvalCaseInput>, never, Scope.Scope>`. The run owner
must retain that Scope through every accepted case, runner cleanup and final hooks,
before closing the store. Returned callbacks require no services. Process and
WebSocket acquisition use executor scope ownership; callback close joins admitted
fibers before closing its receiver. The Promise connection probe has an exact S8b
forward bridge spanning acquisition, invocation and teardown.

B2 still owns application acquisition, event delivery and cancellation services.
B1 adapter checks do not establish full S7 compilation or integration acceptance.

## S7 local B2 application lifetime

`runConfiguration` and `cancelConfiguration` now return native Effects. Eval hosts
supply `withEvalApplication` once at their composition root. That root provides one
`CancellationRegistry` service and one store owner, with one runs/cache handle per
project path. A returned event source does not own the run lifetime. Runs fork into
the captured application Scope and the root joins them before closing storage.
Caller interruption requests abort, joins accepted evidence and cleanup, and retains
the original failure Cause. SIGINT remains business cancellation input.

Cancellation publication and unregister are masked and joined. The scoped 25ms poller
accepts only its run token and unregister removes only the matching generation.
Uncertain persistence or runtime cleanup detaches polling and retains durable ownership.
The event producer returns an Effect; the single-consumer AsyncIterable is the explicit
Commander boundary. The CLI root retains native services through Commander completion.
Eval progress streams immediately; terminal output waits for shared-store release. A failed
release keeps an earlier command or infrastructure failure and its exit code. Otherwise it
replaces a pass, failed verdict or cancelled outcome with one catalogued CLI failure.
The existing Promise dashboard launcher captures a registry at construction and keeps
its S9a forward bridge. No S7a/S7b production execution bridge remains.

Executor retry failure Causes retain an immutable prior-attempt receipt, inspected by
`getInvocationPriorAttempts`. Local ordinary recovery receives the full Cause, appends
the terminal cleanup attempt once, and redacts excerpts using completed cleanup response
values. Defects and mixed Causes bypass ordinary projection. These are intentional
TypeScript composition breaks; wire fields, hashes, schemas, scripts and environment
variables are unchanged.

## S8c cloud and registry API migration

Local cloud requests, credentials, links, revisions, uploads, token management and
registry writes now return native Effects. `CloudClient.request` and `upload`
return `Effect<T, LocalError>`. Injected clients and command test services must
return Effects too. The private attest-cloud test imports of these public local
APIs must adopt the new signatures. That private host was not edited or verified.
Registry catalog reads retain their S2 API.

HTTP requests dispatch once. Caller cancellation and the existing deadlines abort
the owned controller; accepted requests join the foreign fetch and body operation
before releasing local ownership. An implementation that ignores abort can delay
shutdown indefinitely. An unknown response never authorizes automatic replay or
proves remote rollback. Dry runs, wire formats, full bundle bytes, registry file
modes, synchronization hash fences and manifest-last publication are unchanged.

Release failures retain the complete primary Exit internally. A primary failure,
defect or interruption stays primary with release diagnostics attached. A release
failure after success is a typed failure with the completed value retained in its
cause; callers must not repeat a completed mutation because only cleanup failed.
Temporary CLI composition bridges belong to S9b, and the project-init bridge to
S8b. No Promise compatibility API is retained.

After successful link/sync publication, failed release reports
`project_saved_cleanup_failed` with `committed: true`. Registry release failure
reports `registry_write_failed`. HTTP body release failure reports
`cloud_request_failed`. These cleanup diagnostics are deliberate behavior changes
under R1 through R3; primary public failure codes take precedence. Cloud body
cancellation has a one-second acknowledgement bound. Expiry retains unconfirmed
cleanup and does not imply remote completion.

## Native client runner ownership

Client handlers and operations now return native Effects. `createAgentRunner` and the Node
listener require an explicit Scope. `withAgentRunner(options, use)` brackets use and shutdown,
keeping the primary Cause and retaining all failed cleanup. Prefer it when the caller needs a
typed result for the complete lifetime. Low-level scoped constructors retain release receipts;
call `close()` before scope disposal when shutdown failure must reach the caller's E channel.
Accepted invocations live in a runner-owned FiberSet and survive completion of the trigger's
request root. Node HTTP callbacks run one request Effect each and retain their Promise roots
until listener shutdown joins them. None owns the accepted handler's lifetime.

Runner admission is capped at 64 active handlers and 10,000 retained registration tokens.
At the receipt limit, admission evicts the oldest terminal receipt, never active work. A retained
registration is never replayed. An evicted token is treated as a new registration. Handlers receive shutdown
through the context AbortSignal, have three seconds for cooperative terminal evidence, and then
face native interruption. Terminal handler and delivery Exits remain internal receipts. Scope shutdown has a separate receipt.
Drain retains failures from all receipts still in its retention window.
Drain observes for 35 seconds; explicit close then interrupts outstanding work. Foreign Promise
interruption does not prove cancellation of the remote operation.

Completion delivery preserves three attempts and the 250 ms/1 second delays for confirmed 5xx.
Opaque rejection or timeout now prohibits replay. A confirmed 2xx stays delivered even if body
release fails, with cleanup Causes retained. Failed cleanup after 5xx prohibits retry. A late
foreign response releases its body through its foreign callback and updates the same receipt.
The browser bundle/import receipt covers portable dependencies, not a Workers deployment or
private host lifetime policy. Node and Pi imports remain separate subpaths.

Cleanup bounds belong to the resource owner. Request readers and process teardown use explicit
foreign-call bounds. Pi workspace removal is joined until the local filesystem operation settles.
Runner close has its own drain bound and receives no shorter outer timeout. Nested releases append
their Causes without replacing the primary failure. Foreign handlers should use `Effect.tryPromise`
to classify expected operational failures; `Effect.promise` turns rejections into defects, which
remain in terminal receipts and are reported through drain or close.

```mermaid
flowchart TD
  A[Authenticated trigger] --> B{Admission and retained-token check}
  B -->|New registration| C[Runner-owned FiberSet]
  B -->|Retained duplicate| D[Return 202 without replay]
  C --> E[Handler result and completion delivery]
  E --> F[Terminal receipt in bounded retention window]
  G[Close stops admission] --> H[Abort signal and cooperative grace]
  H --> I[Drain delivery and join accepted work]
  I --> J[Interrupt remaining fibers and retain shutdown Exit]
  F --> I
```

## Native resource commands

Resource authoring and inspection operations in local now return Effect directly. This is a
public TypeScript API break. Agent add/import/rename/remove, metric authoring and mutations,
test/case/dataset authoring and reads, generic list/show, project show/validate, request-document
reads, bounded tabular import reads, and manifest publication compose with `yield*`.
Pure resource builders, semantic diffs, cURL parsing, reference rewrites and import algorithms
remain synchronous unless they read external input.

```ts
import * as Effect from 'effect/Effect';
import { runAgentAddCommand } from '@attest/local/agent';
import { runProjectShowCommand } from '@attest/local/project';

// The host supplies typed options and runs this program at its application entry point.
const authorAndInspect = (options: Parameters<typeof runAgentAddCommand>[0]) =>
  Effect.gen(function* () {
    yield* runAgentAddCommand(options);
    return yield* runProjectShowCommand({
      project: options.project,
      workingDirectory: options.workingDirectory,
    });
  });
```

Mutation confirmation callbacks return `Effect<void, LocalError>`. The command adapts an
individual foreign terminal prompt callback; the native mutation coordinator does not execute
an Effect runtime. Dry-run returns before confirmation and uses the native transaction preview.
The candidate's loaded hash remains the commit guard, with manifest-last publication owned by
the project transaction. Transaction cleanup errors and committed evidence propagate unchanged.

Bounded import iterators are closed even after validation failure. Remote JSON readers attempt
both cancellation and lock release, with a one-second cancellation bound. Reader cleanup is
masked and retains its full Cause. A successful read followed by failed cleanup fails through E
and keeps the successful value internally. Primary typed failure, interruption and defects retain
precedence, with cleanup diagnostics attached as `CommandCleanup`. cURL body reads use the
existing anchored descriptor owner. Manifest publication masks pending filesystem operations,
attempts every cleanup, and rolls back its exact no-overwrite publication on failure.

Agent and metric tests, probe input reads, and project initialization now return native Effects.
Probe execution callbacks return Effects too. Agent sessions and sandboxes close before the probe
store finalizes its run and closes. Interruption finalizes a recorded probe as cancelled. Init
publishes and verifies its manifest before native registry registration. Verification is the commit
point. A failure or interruption before it rolls back the exact published bytes and removes a newly
created directory. After it, a registry failure reports `registry_write_failed` and keeps the
manifest, so `attest projects add` can register it later. Dry runs still write nothing.

Commander submits the native probe and init programs through the shared CLI application root.
No S8b execution bridges remain.

## S9a native dashboard operations

`RunControl` and API client operations return native Effects with captured dependencies.
The launcher acquisition captures the process-root CancellationRegistry; its methods require no
services. Dashboard starts still spawn a detached CLI, which owns its database and run scope.
Start admission is masked through its bounded handshake and process cleanup. HTTP disconnect
does not cancel an accepted start, and uncertain cleanup never authorizes another launch.
Hono read/cancel handlers and TanStack query/mutation callbacks are explicit execution roots.
Remote mutation completion remains unknown after an opaque transport failure; clients do not retry it.

`startViewServer` requires Scope. Its handle exposes native `close` and `closed` Effects.
Close stops admission, joins the listener and accepted Hono callbacks, then invokes catalog release
with the primary Exit. The view command owns its StoreScope outside that server scope. Startup
failure therefore reaches the store owner before release. Cleanup receipts retain every failed
release; primary typed failures, defects and interruption keep their Cause classification.
These are deliberate TypeScript API breaks; wire schemas, status codes, and the detached CLI
protocol are unchanged. The integrated S8b lane removes the unused PromiseStoreOwner helper.

## main-merge dashboard projections and web command

The local `main` merge retains native `RunSource`, `RunStore`, `ProjectCatalog` and API client
operations. The new `getProjectOverview`, `listEvals`, `listEvalRuns`, `getEvalCaseWindow`,
`getCaseHistory`, `getActivity` and `listRunSuites` methods return `Effect<A, StoreError>` with
no required services. Dashboard reads hold one Kysely read transaction across all statements. An Effect resource
bracket owns the connection independently of BEGIN, COMMIT and ROLLBACK, so a failed command
still releases the shared path lock. Failed commits attempt rollback. Acquisition and cleanup
are masked, while the read body remains interruptible. Commit or rollback is joined before the
store owner can close, and cleanup failure retains the primary Cause through `finishStoreCleanup`.

Projection writes and migration backfills retain SQL-only Kysely/driver callbacks inside the
masked native transaction owner. They do not execute an Effect runtime. Version 2 SQL, selected
case membership, immutable evidence timestamps, UTC index ordering and stored projections match
main. Planned-case derivation and eval-slice analytics remain pure synchronous functions.
Dashboard and shell preference schemas use Effect Schema with main's strip/strict behavior.
Public stored and HTTP shapes remain unchanged; hosts implementing RunSource must implement the
seven new native methods. The canonical dashboard CLI command is `attest web`, including
`--all`, `--store`, `--port` and `--no-open`. Commander, Hono and TanStack callbacks retain their
existing execution-root ownership. No migration bridge is added.
Init write failures preserve the base error envelope, including the target path and staged
content hash. Rollback or directory-removal failure reports `project_recovery_required` before
the primary verification failure, with both Causes retained. Agent and metric command error
channels preserve dependency failures for CLI redaction and `cause_code` classification.
Rejected init prompts likewise reach the CLI serializer unchanged.

## S9b native CLI application programs

Commander actions submit one Effect through `CommandContext.submit`; `run-cli.ts` executes
that program inside the existing eval application scope. Request builders, authoring helpers,
cloud commands and eval event collection now compose native Effects. `readOrBuildRequest`
requires an Effect-returning builder. `readJsonRequest`, metric guided loading, mutation helpers
and `collectEvalEvents` return Effects. These are intentional internal TypeScript API breaks.
The process-facing `runCli` API still returns `Promise<number>`.

The root owns one process cancellation signal and supplies it to terminal prompts and command
operations. Ordinary native commands interrupt and join their scoped resources before reporting
cancellation. Eval retains business cancellation so accepted evidence and its validated JSONL
terminal sequence can finish. Completed eval upload failures remain advisory. Terminal eval output
still waits for application release, and an earlier infrastructure or command error keeps its
catalog identity and exit code when cleanup fails. No wire, hash, schema, environment or script
changes are made. The two execution-test calls remain Promise operations owned by S8b phase B;
only their request building and application handoff are converted here.

## Integrated S8b-B and S9b CLI root

Agent and metric tests, probe input reads, and project init compose native Effects directly
through `CommandContext.submit`. The unused PromiseStoreOwner and its owner-handshake tests
are removed; eval store-path fixtures now use the native store scope. No migration execution
bridges remain. The empty ledger and its lint rule remain until S10. `runCli` stays
`Promise<number>`. Native local test/init signatures are deliberate TypeScript API breaks.

## CLI failure and eval run lifetime

The CLI root propagates command failure to the eval application before joining admitted runs.
The application aborts those runs through their owned controllers, preserving evidence finalization
and the earlier command Cause. Signal listeners span the application join and store release.
`CliExit` keeps its selected exit code and deferred terminal publisher. Eval cancel composes
its native result directly, as eval run does; upload failure remains advisory.

## Assembled main CLI commands

The merged `web`, `projects`, `report`, `trace convert`, `diff`, `help` and `errors` actions
submit one native program to the shared CLI application root. Web uses the root's process signal;
its scoped server and store are joined before application disposal. Registry and run-store errors
reach the shared serializer without a command-local runtime. Eval output remains pure rendering.
The temporary bridge ledger is empty and retained for S10 removal. No wire or storage API changes
are introduced by this integration.
