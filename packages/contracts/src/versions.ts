/** Identifies the agent request and response envelopes described by the agent contract. */
const AGENT_PROTOCOL = 'attest.agent/v1alpha1' as const;

/** Identifies trace documents described by the trace schema contract. */
const TRACE_SCHEMA_VERSION = 'attest.trace/v1alpha1' as const;

/** Identifies executable metric envelopes described by the metric contract. */
const METRIC_PROTOCOL = 'attest.metric/v1alpha1' as const;

/** Identifies the configuration format described by the v1 config contract. */
const CONFIG_VERSION = 1 as const;

export { AGENT_PROTOCOL, CONFIG_VERSION, METRIC_PROTOCOL, TRACE_SCHEMA_VERSION };
