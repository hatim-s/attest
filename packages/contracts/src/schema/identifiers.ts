/** Identifies the agent invocation request and response envelopes. */
const AGENT_PROTOCOL = 'attest.agent-invocation';

/** Identifies trace documents described by the trace schema contract. */
const TRACE_SCHEMA_ID = 'attest.trace';

/** Identifies executable metric envelopes described by the metric contract. */
const METRIC_PROTOCOL = 'attest.metric-evaluation';

/** Identifies the generated project manifest. */
const PROJECT_SCHEMA_ID = 'attest.project';

/** Identifies a canonical agent resource. */
const AGENT_RESOURCE_SCHEMA_ID = 'attest.agent';

/** Identifies a canonical test resource. */
const TEST_RESOURCE_SCHEMA_ID = 'attest.test';

/** Identifies test cases stored inline or as JSONL rows. */
const CASE_SCHEMA_ID = 'attest.case';

/** Identifies canonical metadata for a dataset JSONL file. */
const DATASET_SCHEMA_ID = 'attest.dataset';

/** Identifies a canonical metric resource. */
const METRIC_RESOURCE_SCHEMA_ID = 'attest.metric';

/** Identifies the inspectable built-in metric preset catalog. */
const METRIC_PRESET_SCHEMA_ID = 'attest.metric-preset';

/** Identifies local fixture documents accepted by `attest metric test`. */
const METRIC_TEST_FIXTURE_SCHEMA_ID = 'attest.metric-test-fixture';

/** Identifies normalized mutation requests accepted by --from-json. */
const COMMAND_REQUEST_SCHEMA_ID = 'attest.command-request';

/** Identifies immutable eval-run snapshot metadata persisted at orchestration start. */
const EVAL_RUN_SCHEMA_ID = 'attest.eval-run';

/** Identifies the single-document success and failure envelope written by the CLI. */
const CLI_RESULT_SCHEMA_ID = 'attest.cli-result';

/** Identifies one line in a streaming CLI JSONL response. */
const CLI_EVENT_SCHEMA_ID = 'attest.cli-event';

/** Identifies the machine-readable command tree returned by `attest help`. */
const CLI_HELP_SCHEMA_ID = 'attest.cli-help';

/** Identifies the stable CLI error registry returned by `attest errors`. */
const CLI_ERROR_CATALOG_SCHEMA_ID = 'attest.cli-errors';

/** Identifies normalized WebSocket invocation requests at the adapter boundary. */
const WEBSOCKET_REQUEST_PROTOCOL = 'attest.websocket-request';

/** Identifies correlated WebSocket messages after authored pointer extraction. */
const WEBSOCKET_MESSAGE_PROTOCOL = 'attest.websocket-message';

/** Identifies persisted bounded/redacted evidence from one WebSocket attempt. */
const WEBSOCKET_EVIDENCE_SCHEMA_ID = 'attest.websocket-evidence';

export {
  AGENT_PROTOCOL,
  AGENT_RESOURCE_SCHEMA_ID,
  CASE_SCHEMA_ID,
  CLI_ERROR_CATALOG_SCHEMA_ID,
  CLI_EVENT_SCHEMA_ID,
  CLI_HELP_SCHEMA_ID,
  CLI_RESULT_SCHEMA_ID,
  COMMAND_REQUEST_SCHEMA_ID,
  DATASET_SCHEMA_ID,
  EVAL_RUN_SCHEMA_ID,
  METRIC_PROTOCOL,
  METRIC_PRESET_SCHEMA_ID,
  METRIC_RESOURCE_SCHEMA_ID,
  METRIC_TEST_FIXTURE_SCHEMA_ID,
  PROJECT_SCHEMA_ID,
  TEST_RESOURCE_SCHEMA_ID,
  TRACE_SCHEMA_ID,
  WEBSOCKET_EVIDENCE_SCHEMA_ID,
  WEBSOCKET_MESSAGE_PROTOCOL,
  WEBSOCKET_REQUEST_PROTOCOL,
};
