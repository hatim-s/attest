# Cloud commands

Cloud alpha runs HTTP agents, including supported HTTP streaming protocols. Local `eval run` and CI keep their existing transports and sandboxes.

Start from an existing Attest project:

```sh
attest cloud login --url https://YOUR-CLOUD-ORIGIN
attest cloud project create 'Support evaluation'
attest cloud link PROJECT_ID
attest cloud push --no-secrets
attest cloud run --all --output json
attest cloud status RUN_ID --output json
attest cloud events RUN_ID --after 0 --output json
attest cloud result RUN_ID --output json
attest cloud cancel RUN_ID
attest cloud logout
```

Login prints an approval URL and a short code. Approve it in your signed-in browser. The CLI exchanges a PKCE device session for a revocable token, stores it in `~/.attest/cloud/credentials.json` with mode `0600`, and binds it to that cloud origin. Logout revokes the session before removing its local token. Tokens never enter project revisions or command success output.

`cloud link` records the cloud origin, project ID, synchronized revision, and file hashes in `.attest/cloud.json`. It refuses to replace a link to another project. `cloud project list` lists projects available to the authenticated account.

## Push and pull

Push uploads an immutable revision containing the project manifest, its referenced resources and datasets, and explicitly referenced metric code. It does not scan the project directory, read `.env`, resolve secret references, or include `.attest`, credentials, caches, or unrelated files. Known credential-bearing request fields must use environment secret references. The upload JSON, including its envelope, must fit in 5 MiB. Alpha files must be UTF-8 text.

Inspect case data, request templates, and custom metric source before passing `--no-secrets`. Structural validation cannot identify every secret in arbitrary text or code. The acknowledgement is required when file bytes change; pushing an unchanged synchronized revision does not require it again.

Custom metrics use a self-contained TypeScript or Python entrypoint under `attest/metrics/code/`. Supported commands are `bun attest/metrics/code/name.ts`, `python3 attest/metrics/code/name.py`, or `python attest/metrics/code/name.py`. Cloud alpha does not install project dependencies, accept extra command arguments, or copy arbitrary local imports. Unsupported source dependencies fail preflight or isolated execution. Custom code runs in the cloud's isolated metric environment.

`cloud pull` downloads the current revision. Use `--revision REVISION_ID` for a specific one. Pull compares each affected path with its last synchronized byte hash. It rejects changed, deleted, or newly occupied local files and reports their paths. It never offers a force-overwrite mode. Publication uses the existing project lock and recoverable transaction journal, with the manifest last. Unrelated local files remain in place.

The first pull into a linked directory can accept identical files or absent files. A differing existing file has no synchronized base and is a conflict. Push the local project as its first revision, or reconcile those files before pulling.

## Disconnect and reconnect

`cloud run` submits the linked revision and returns immediately. It prints a retry key before submission. If the response is lost, repeat the same command with `--idempotency-key KEY` to retrieve the same submission instead of starting another run. Changing selection or revision requires a new key.

Use `cloud status RUN_ID` to check progress. `cloud events RUN_ID --after CURSOR` fetches persisted events and returns `next_cursor`. Save that cursor and use it on the next request; reconnecting never resubmits agent calls. `cloud cancel RUN_ID` requests remote cancellation. Closing the CLI does not cancel a submitted run.

Project definitions and datasets persist as saved revisions. Per-run raw inputs, outputs, traces, and artifacts expire five days after finalization. Run summaries remain available after evidence expires. `--output json` uses the CLI's standard structured success and error envelopes.
