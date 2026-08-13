# Telemetry policy

Telemetry is not implemented. Attest sends no usage events today. This document records the
approved disclosure contract for a future implementation; that implementation must update this
page in the same change and may not collect anything not listed here.

## What may be collected

Once implemented, at most one event may be sent per CLI command invocation:

| Field          | Example               | Notes                                                                                                         |
| -------------- | --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `event`        | `command_invoked`     | Only event type today.                                                                                        |
| `command`      | `eval.run`            | Stable command identifier only — never arguments.                                                             |
| `version`      | `0.3.1`               | attest version.                                                                                               |
| `os` / `arch`  | `darwin` / `arm64`    | Platform triple components.                                                                                   |
| `runtime`      | `bun-1.3` / `node-22` | Executing runtime family.                                                                                     |
| `ci`           | `true`                | Whether a CI environment was detected (`CI` env var).                                                         |
| `anonymous_id` | random UUID           | Generated once, stored in the attest config dir. Contains and derives from nothing about you or your machine. |
| `schema`       | `attest.telemetry`    | Event schema version; changes to collected fields bump it and this document.                                  |

## What must never be collected

Prompts, outputs, traces, test cases, scores, file paths or names, config contents, environment variables, API keys, hostnames, IP-derived identity, git metadata. Telemetry code is in the open-source tree — verify it.

## Required opt-out

The implementation must support both of:

```bash
export ATTEST_TELEMETRY=0
export DO_NOT_TRACK=1
```

Opting out must be immediate and complete — no "essential" events may remain.

## Disclosure

Before any event is sent, the first interactive invocation must print a one-time notice pointing to
this document and the opt-out. CI environments must not trigger the notice, but the future
implementation may send the documented event unless opted out.
