# Telemetry

attest collects **anonymous usage telemetry** to understand which commands and features matter. This document is the complete, exhaustive description of what is collected. If it's not listed here, it is not sent.

## What is collected

One event per CLI command invocation:

| Field          | Example                         | Notes                                                                                                         |
| -------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `event`        | `command_invoked`               | Only event type today.                                                                                        |
| `command`      | `run`, `diff`, `view`, `report` | Top-level command name only — never arguments.                                                                |
| `version`      | `0.3.1`                         | attest version.                                                                                               |
| `os` / `arch`  | `darwin` / `arm64`              | Platform triple components.                                                                                   |
| `runtime`      | `bun-1.3` / `node-22`           | Executing runtime family.                                                                                     |
| `ci`           | `true`                          | Whether a CI environment was detected (`CI` env var).                                                         |
| `anonymous_id` | random UUID                     | Generated once, stored in the attest config dir. Contains and derives from nothing about you or your machine. |
| `schema`       | `attest.telemetry/v1`           | Event schema version; changes to collected fields bump it and this document.                                  |

## What is never collected

Prompts, outputs, traces, test cases, scores, file paths or names, config contents, environment variables, API keys, hostnames, IP-derived identity, git metadata. Telemetry code is in the open-source tree — verify it.

## Opting out

Any of:

```bash
export ATTEST_TELEMETRY=0        # environment, wins over config
attest config set telemetry false
```

Setting `DO_NOT_TRACK=1` is also honored. Opting out is immediate and complete — no "essential" events remain.

## Disclosure

The first interactive invocation prints a one-time notice pointing to this document and the opt-out, before any event is sent. CI environments never trigger the notice (but do send events unless opted out — set `ATTEST_TELEMETRY=0` in your pipeline if you prefer).
