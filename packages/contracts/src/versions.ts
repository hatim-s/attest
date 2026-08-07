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

/** Identifies normalized v2 mutation requests accepted by --from-json. */
const COMMAND_REQUEST_SCHEMA_VERSION = 'attest.command-request/v2' as const;

export {
  AGENT_PROTOCOL,
  AGENT_RESOURCE_SCHEMA_VERSION,
  CASE_SCHEMA_VERSION,
  COMMAND_REQUEST_SCHEMA_VERSION,
  CONFIG_VERSION,
  DATASET_SCHEMA_VERSION,
  METRIC_PROTOCOL,
  METRIC_RESOURCE_SCHEMA_VERSION,
  PROJECT_SCHEMA_VERSION,
  TEST_RESOURCE_SCHEMA_VERSION,
  TRACE_SCHEMA_VERSION,
};
