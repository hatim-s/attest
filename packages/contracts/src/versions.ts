/** Identifies the agent request and response envelopes described by the agent contract. */
const AGENT_PROTOCOL = 'attest.agent/v1alpha1' as const;

/** Identifies trace documents described by the trace schema contract. */
const TRACE_SCHEMA_VERSION = 'attest.trace/v1alpha1' as const;

/** Identifies executable metric envelopes described by the metric contract. */
const METRIC_PROTOCOL = 'attest.metric/v1alpha1' as const;

/** Identifies the configuration format described by the v1 config contract. */
const CONFIG_VERSION = 1 as const;

/** Identifies the generated v2 project manifest. */
const PROJECT_SCHEMA_VERSION = 'attest.project/v2' as const;

/** Identifies a canonical v2 agent resource. */
const AGENT_RESOURCE_SCHEMA_VERSION = 'attest.agent/v2' as const;

/** Identifies a canonical v2 test resource. */
const TEST_RESOURCE_SCHEMA_VERSION = 'attest.test/v2' as const;

/** Identifies v2 test cases stored inline or as JSONL rows. */
const CASE_SCHEMA_VERSION = 'attest.case/v2' as const;

/** Identifies canonical metadata for a v2 dataset JSONL file. */
const DATASET_SCHEMA_VERSION = 'attest.dataset/v2' as const;

/** Identifies a canonical v2 metric resource. */
const METRIC_RESOURCE_SCHEMA_VERSION = 'attest.metric/v2' as const;

/** Identifies the inspectable built-in metric preset catalog. */
const METRIC_PRESET_SCHEMA_VERSION = 'attest.metric-preset/v1' as const;

/** Identifies local fixture documents accepted by `attest metric test`. */
const METRIC_TEST_FIXTURE_SCHEMA_VERSION = 'attest.metric-test-fixture/v1' as const;

/** Identifies normalized v2 mutation requests accepted by --from-json. */
const COMMAND_REQUEST_SCHEMA_VERSION = 'attest.command-request/v2' as const;

/** Identifies the single-document success and failure envelope written by the CLI. */
const CLI_RESULT_SCHEMA_VERSION = 'attest.cli-result/v1' as const;

/** Identifies one line in a streaming CLI JSONL response. */
const CLI_EVENT_SCHEMA_VERSION = 'attest.cli-event/v1' as const;

/** Identifies the machine-readable command tree returned by `attest help`. */
const CLI_HELP_SCHEMA_VERSION = 'attest.cli-help/v1' as const;

/** Identifies the stable CLI error registry returned by `attest errors`. */
const CLI_ERROR_CATALOG_SCHEMA_VERSION = 'attest.cli-errors/v1' as const;

/** Identifies normalized WebSocket invocation requests at the adapter boundary. */
const WEBSOCKET_REQUEST_PROTOCOL = 'attest.websocket-request/v1' as const;

/** Identifies correlated WebSocket messages after authored pointer extraction. */
const WEBSOCKET_MESSAGE_PROTOCOL = 'attest.websocket-message/v1' as const;

/** Identifies persisted bounded/redacted evidence from one WebSocket attempt. */
const WEBSOCKET_EVIDENCE_SCHEMA_VERSION = 'attest.websocket-evidence/v1' as const;

export {
  AGENT_PROTOCOL,
  AGENT_RESOURCE_SCHEMA_VERSION,
  CASE_SCHEMA_VERSION,
  CLI_ERROR_CATALOG_SCHEMA_VERSION,
  CLI_EVENT_SCHEMA_VERSION,
  CLI_HELP_SCHEMA_VERSION,
  CLI_RESULT_SCHEMA_VERSION,
  COMMAND_REQUEST_SCHEMA_VERSION,
  CONFIG_VERSION,
  DATASET_SCHEMA_VERSION,
  METRIC_PROTOCOL,
  METRIC_PRESET_SCHEMA_VERSION,
  METRIC_RESOURCE_SCHEMA_VERSION,
  METRIC_TEST_FIXTURE_SCHEMA_VERSION,
  PROJECT_SCHEMA_VERSION,
  TEST_RESOURCE_SCHEMA_VERSION,
  TRACE_SCHEMA_VERSION,
  WEBSOCKET_EVIDENCE_SCHEMA_VERSION,
  WEBSOCKET_MESSAGE_PROTOCOL,
  WEBSOCKET_REQUEST_PROTOCOL,
};
