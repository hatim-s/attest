# Cloud commands

Attest Cloud stores finished local runs and serves their results in the hosted dashboard.
Run evaluations locally with your existing transports and sandboxes, then upload the results.
Cloud execution commands require an execution-enabled deployment. A results-only deployment
returns `execution_unavailable` for hosted execution.

Start from an existing Attest project:

```sh
attest cloud login --url https://YOUR-CLOUD-ORIGIN
attest cloud project create 'Support evaluation'
attest cloud link PROJECT_ID
attest cloud push-run RUN_ID
attest eval run --all --push
attest cloud token create --name ci
attest cloud token list
attest cloud token revoke TOKEN_ID
attest cloud logout
```

Login prints an approval URL and a short code. Approve it in your signed-in browser. The CLI exchanges a PKCE device session for a revocable token, stores it in `~/.attest/cloud/credentials.json` (or `<ATTEST_HOME>/cloud/credentials.json`, see [environment variables](../ENV.md#attest-home-directory)) with mode `0600`, and binds it to that cloud origin. Logout revokes the session before removing its local token. Session tokens never enter project revisions or command success output.
`cloud token create` prints a new project upload token once.

`cloud link` records the cloud origin, project ID, synchronized revision, and file hashes in `.attest/cloud.json`. It refuses to replace a link to another project. `cloud project list` lists projects available to the authenticated account.

## Upload local results

```sh
attest cloud push-run
attest cloud push-run RUN_ID --output json
attest eval run --all --push --output json
```

`push-run` defaults to the newest finished run in this project's local store. It skips
running records across pages. An explicit ID selects that run; the server rejects running
runs with `run_not_finished`. Missing stores or finished runs return `resource_not_found`.
The upload reads a snapshot without modifying or migrating the local database.

The request contains the existing run bundle as NDJSON, including run metadata, case inputs,
outputs, traces, metrics, and inline artifacts present in those records. It does not collect
additional files. Review this evidence before uploading. The server limits bundles to 16 MiB.
The CLI allows two minutes for an upload, compared with 30 seconds for JSON control requests.

Human output is the dashboard URL. Structured output contains `url` and `unchanged`. Uploading
the same bundle again succeeds with `unchanged: true`. Different content for an existing run ID
fails with `run_conflict`. These upload failures print the server message and exit non-zero.

`eval run --push` uploads the run after finalization, including a run with a failing verdict.
It prints the dashboard URL or upload error to stderr and preserves the eval's exit code and
stdout format. A failure before run completion does not trigger upload. `--push` cannot be
combined with `--from-json`.

## Project tokens and CI

Create a token with a saved device session and a linked project:

```sh
attest cloud token create --name ci
attest cloud token list
attest cloud token revoke TOKEN_ID
```

Create prints the `atp_` secret once. Store it in your CI secret manager. List returns token
metadata; revoke disables future use. All three commands reject environment credentials locally
with `token_scope`. Unset both cloud environment variables to use your saved device session.

In CI, set the following pair and upload a finished run:

```sh
export ATTEST_CLOUD_URL=https://YOUR-CLOUD-ORIGIN
# Set ATTEST_CLOUD_TOKEN through your CI secret manager.
attest cloud push-run RUN_ID
```

The environment pair overrides saved credentials. Setting only one variable is an error,
including when saved credentials exist. With neither variable set, Attest uses the saved
session and `.attest/cloud.json` link. With the pair set, `GET /v1/token` identifies the project,
so CI needs no local link. An existing link must agree on the cloud origin and project ID.
Project tokens permit result uploads to their project and token identity lookup only.

## Project revisions and hosted execution

Push uploads an immutable revision containing the project manifest, its referenced resources and datasets, and explicitly referenced metric code. It does not scan the project directory, read `.env`, resolve secret references, or include `.attest`, credentials, caches, or unrelated files. Known credential-bearing request fields must use environment secret references. The upload JSON, including its envelope, must fit in 5 MiB. Alpha files must be UTF-8 text.

Inspect case data, request templates, and custom metric source before passing `--no-secrets`. Structural validation cannot identify every secret in arbitrary text or code. The acknowledgement is required when file bytes change; pushing an unchanged synchronized revision does not require it again.

Custom metrics use a self-contained TypeScript or Python entrypoint under `attest/metrics/code/`. Supported commands are `bun attest/metrics/code/name.ts`, `python3 attest/metrics/code/name.py`, or `python attest/metrics/code/name.py`. Cloud alpha does not install project dependencies, accept extra command arguments, or copy arbitrary local imports. Unsupported source dependencies fail preflight or isolated execution. Custom code runs in the cloud's isolated metric environment when execution is enabled.

`cloud pull` downloads the current revision. Use `--revision REVISION_ID` for a specific one. Pull compares each affected path with its last synchronized byte hash. It rejects changed, deleted, or newly occupied local files and reports their paths. It never offers a force-overwrite mode. Publication uses the existing project lock and recoverable transaction journal, with the manifest last. Unrelated local files remain in place.

The first pull into a linked directory can accept identical files or absent files. A differing existing file has no synchronized base and is a conflict. Push the local project as its first revision, or reconcile those files before pulling.

## Disconnect and reconnect

`cloud run` submits the linked revision and returns immediately. It prints a retry key before submission. If the response is lost, repeat the same command with `--idempotency-key KEY` to retrieve the same submission instead of starting another run. Changing selection or revision requires a new key.

Use `cloud status RUN_ID` to check progress. `cloud events RUN_ID --after CURSOR` fetches persisted events and returns `next_cursor`. Save that cursor and use it on the next request; reconnecting never resubmits agent calls. `cloud cancel RUN_ID` requests remote cancellation. Closing the CLI does not cancel a submitted run.

Project definitions and datasets persist as saved revisions. For hosted execution, per-run raw inputs, outputs, traces, and artifacts expire five days after finalization. Run summaries remain available after evidence expires. This expiry does not describe uploaded local run bundles. `--output json` uses the CLI's standard structured success and error envelopes.
