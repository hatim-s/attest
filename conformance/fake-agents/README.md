# Hostile fake agents

These zero-dependency fixtures make runner failures deterministic.

## Usage

CLI: `printf '%s' '{"protocol":"attest.agent/v1alpha1","run_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","case_id":"demo","input":{}}' | node conformance/fake-agents/cli-agent.cjs --behavior=happy`

HTTP: `PORT=3000 node conformance/fake-agents/http-agent.cjs`, then `curl -X POST http://127.0.0.1:3000/happy -H 'content-type: application/json' -d '{"protocol":"attest.agent/v1alpha1","run_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","case_id":"demo","input":{}}'`

| behavior                | transport availability | what it exercises                         | env knobs               |
| ----------------------- | ---------------------- | ----------------------------------------- | ----------------------- |
| happy                   | CLI, HTTP              | valid response                            | —                       |
| hang                    | CLI, HTTP              | invocation timeout                        | —                       |
| malformed-json          | CLI, HTTP              | invalid JSON handling                     | —                       |
| huge-output             | CLI, HTTP              | response-size cap                         | `AGENT_HUGE_BYTES`      |
| partial-stdout          | CLI, HTTP              | truncated response handling               | —                       |
| stderr-noise            | CLI, HTTP              | stderr isolation                          | —                       |
| nonzero-exit            | CLI                    | non-zero process exit                     | —                       |
| status-500 / status-404 | HTTP                   | retryable and non-retryable HTTP failures | —                       |
| orphan-child            | CLI, HTTP              | process-tree cleanup                      | `ORPHAN_HEARTBEAT_FILE` |
| slow-drip               | CLI, HTTP              | deadline enforcement during progress      | `AGENT_DRIP_MS`         |
| with-trace              | CLI, HTTP              | valid trace ingestion                     | —                       |
| malformed-trace         | CLI, HTTP              | trace warning degradation                 | —                       |
