/** Identifies the agent invocation request and response envelopes. */
const AGENT_PROTOCOL = 'attest.agent-invocation' as const;
const CURRENT_AGENT_PROTOCOL = 'attest.agent-invocation' as const;
const LEGACY_AGENT_PROTOCOL = 'attest.agent/v1alpha1' as const;

/** Identifies trace documents described by the trace schema contract. */
const TRACE_SCHEMA_ID = 'attest.trace' as const;

/** Identifies executable metric envelopes described by the metric contract. */
const METRIC_PROTOCOL = 'attest.metric/v1alpha1' as const;
const CURRENT_METRIC_PROTOCOL = 'attest.metric-evaluation' as const;
const LEGACY_METRIC_PROTOCOL = 'attest.metric/v1alpha1' as const;

/** Identifies the generated project manifest. */
const PROJECT_SCHEMA_ID = 'attest.project' as const;

/** Identifies a canonical agent resource. */
const AGENT_RESOURCE_SCHEMA_ID = 'attest.agent' as const;

/** Identifies a canonical test resource. */
const TEST_RESOURCE_SCHEMA_ID = 'attest.test' as const;

/** Identifies test cases stored inline or as JSONL rows. */
const CASE_SCHEMA_ID = 'attest.case' as const;

/** Identifies canonical metadata for a dataset JSONL file. */
const DATASET_SCHEMA_ID = 'attest.dataset' as const;

/** Identifies a canonical metric resource. */
const METRIC_RESOURCE_SCHEMA_ID = 'attest.metric' as const;

/** Identifies the inspectable built-in metric preset catalog. */
const METRIC_PRESET_SCHEMA_ID = 'attest.metric-preset' as const;

/** Identifies local fixture documents accepted by `attest metric test`. */
const METRIC_TEST_FIXTURE_SCHEMA_ID = 'attest.metric-test-fixture' as const;

/** Identifies normalized mutation requests accepted by --from-json. */
const COMMAND_REQUEST_SCHEMA_ID = 'attest.command-request' as const;

/** Identifies immutable eval-run snapshot metadata persisted at orchestration start. */
const EVAL_RUN_SCHEMA_ID = 'attest.eval-run' as const;

/** Identifies the single-document success and failure envelope written by the CLI. */
const CLI_RESULT_SCHEMA_ID = 'attest.cli-result' as const;

/** Identifies one line in a streaming CLI JSONL response. */
const CLI_EVENT_SCHEMA_ID = 'attest.cli-event' as const;

/** Identifies the machine-readable command tree returned by `attest help`. */
const CLI_HELP_SCHEMA_ID = 'attest.cli-help' as const;

/** Identifies the stable CLI error registry returned by `attest errors`. */
const CLI_ERROR_CATALOG_SCHEMA_ID = 'attest.cli-errors' as const;

/** Identifies normalized WebSocket invocation requests at the adapter boundary. */
const WEBSOCKET_REQUEST_PROTOCOL = 'attest.websocket-request' as const;

/** Identifies correlated WebSocket messages after authored pointer extraction. */
const WEBSOCKET_MESSAGE_PROTOCOL = 'attest.websocket-message' as const;

/** Identifies persisted bounded/redacted evidence from one WebSocket attempt. */
const WEBSOCKET_EVIDENCE_SCHEMA_ID = 'attest.websocket-evidence' as const;

// Transitional identifiers keep downstream stack slices buildable. The final slice removes them.
const AGENT_RESOURCE_SCHEMA_VERSION = 'attest.agent/v2' as const;
const CASE_SCHEMA_VERSION = 'attest.case/v2' as const;
const CLI_ERROR_CATALOG_SCHEMA_VERSION = CLI_ERROR_CATALOG_SCHEMA_ID;
const CLI_EVENT_SCHEMA_VERSION = CLI_EVENT_SCHEMA_ID;
const CLI_HELP_SCHEMA_VERSION = CLI_HELP_SCHEMA_ID;
const CLI_RESULT_SCHEMA_VERSION = CLI_RESULT_SCHEMA_ID;
const COMMAND_REQUEST_SCHEMA_VERSION = 'attest.command-request/v2' as const;
const DATASET_SCHEMA_VERSION = 'attest.dataset/v2' as const;
const EVAL_RUN_SCHEMA_VERSION = 'attest.eval-run/v1' as const;
const METRIC_PRESET_SCHEMA_VERSION = 'attest.metric-preset/v1' as const;
const METRIC_RESOURCE_SCHEMA_VERSION = 'attest.metric/v2' as const;
const METRIC_TEST_FIXTURE_SCHEMA_VERSION = 'attest.metric-test-fixture/v1' as const;
const PROJECT_SCHEMA_VERSION = 'attest.project/v2' as const;
const TEST_RESOURCE_SCHEMA_VERSION = 'attest.test/v2' as const;
const TRACE_SCHEMA_VERSION = 'attest.trace/v1alpha1' as const;
const WEBSOCKET_EVIDENCE_SCHEMA_VERSION = 'attest.websocket-evidence/v1' as const;
const WEBSOCKET_MESSAGE_PROTOCOL_VERSION = 'attest.websocket-message/v1' as const;
const WEBSOCKET_REQUEST_PROTOCOL_VERSION = 'attest.websocket-request/v1' as const;

/** Accepts the current identifier and the previous stack input until the final migration slice. */
const currentOrLegacyIdentifier = <Current extends string, Legacy extends string>(
  current: Current,
  legacy: Legacy,
) => z.union([z.literal(current), z.literal(legacy)]);

export {
  AGENT_PROTOCOL,
  AGENT_RESOURCE_SCHEMA_ID,
  AGENT_RESOURCE_SCHEMA_VERSION,
  CASE_SCHEMA_ID,
  CASE_SCHEMA_VERSION,
  CLI_ERROR_CATALOG_SCHEMA_ID,
  CLI_ERROR_CATALOG_SCHEMA_VERSION,
  CLI_EVENT_SCHEMA_ID,
  CLI_EVENT_SCHEMA_VERSION,
  CLI_HELP_SCHEMA_ID,
  CLI_HELP_SCHEMA_VERSION,
  CLI_RESULT_SCHEMA_ID,
  CLI_RESULT_SCHEMA_VERSION,
  COMMAND_REQUEST_SCHEMA_ID,
  COMMAND_REQUEST_SCHEMA_VERSION,
  CURRENT_AGENT_PROTOCOL,
  CURRENT_METRIC_PROTOCOL,
  DATASET_SCHEMA_ID,
  DATASET_SCHEMA_VERSION,
  EVAL_RUN_SCHEMA_ID,
  EVAL_RUN_SCHEMA_VERSION,
  LEGACY_AGENT_PROTOCOL,
  LEGACY_METRIC_PROTOCOL,
  METRIC_PROTOCOL,
  METRIC_PRESET_SCHEMA_ID,
  METRIC_PRESET_SCHEMA_VERSION,
  METRIC_RESOURCE_SCHEMA_ID,
  METRIC_RESOURCE_SCHEMA_VERSION,
  METRIC_TEST_FIXTURE_SCHEMA_ID,
  METRIC_TEST_FIXTURE_SCHEMA_VERSION,
  PROJECT_SCHEMA_ID,
  PROJECT_SCHEMA_VERSION,
  TEST_RESOURCE_SCHEMA_ID,
  TEST_RESOURCE_SCHEMA_VERSION,
  TRACE_SCHEMA_ID,
  TRACE_SCHEMA_VERSION,
  WEBSOCKET_EVIDENCE_SCHEMA_ID,
  WEBSOCKET_EVIDENCE_SCHEMA_VERSION,
  WEBSOCKET_MESSAGE_PROTOCOL,
  WEBSOCKET_MESSAGE_PROTOCOL_VERSION,
  WEBSOCKET_REQUEST_PROTOCOL,
  WEBSOCKET_REQUEST_PROTOCOL_VERSION,
  currentOrLegacyIdentifier,
};
import { z } from 'zod';
