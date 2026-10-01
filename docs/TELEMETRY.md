# Telemetry policy

Attest collects no telemetry and sends no usage events.

A future telemetry change must update this page in the same commit. It must honor
`ATTEST_TELEMETRY=0` and `DO_NOT_TRACK=1` as a complete opt-out.

Telemetry must never collect prompts, outputs, traces, test cases, scores, file paths, config
contents, environment variables, API keys, hostnames, or git metadata.
