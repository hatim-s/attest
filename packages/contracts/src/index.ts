export { AttestError } from './errors/attest-error.js';
export type { Result } from './result.js';
export { CONTRACT_JSON_SCHEMAS, serializeContractSchema } from './schema/json-schema.js';
export {
  parseAgentRequest,
  parseAgentResponse,
  parseMetricRequest,
  parseMetricResult,
  parseTrace,
} from './schema/parse.js';
export type { ContractIssue, ContractWarning, ParseReport } from './schema/parse.js';
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
  WEBSOCKET_REQUEST_PROTOCOL,
} from './schema/identifiers.js';

export { agentRequestSchema } from './agent/protocol.js';
export type { AgentErrorResponse, AgentRequest, AgentResponse } from './agent/protocol.js';
export { jsonlBridgeOutputSchema } from './agent/jsonl-bridge.js';
export {
  webSocketConnectionModeSchema,
  webSocketTransportSchema,
} from './agent/websocket-contract.js';
export type {
  WebSocketAttemptEvidence,
  WebSocketErrorClassification,
} from './agent/websocket-evidence.js';

export { spanKindSchema, traceSchema } from './trace/protocol.js';
export type { Span, SpanKind, Trace } from './trace/protocol.js';

export { assertionCheckSchema, spanFilterSchema } from './metric/protocol.js';
export type {
  AssertionCheck,
  LeafAssertionCheck,
  MetricDefinition,
  MetricRequest,
  MetricResult,
  SpanFilter,
  ToolArgumentMatcher,
} from './metric/protocol.js';
export { METRIC_PRESETS, metricPresetIdSchema, metricPresetSchema } from './metric/presets.js';
export type { MetricPreset, MetricPresetId } from './metric/presets.js';
export { metricTestFixtureSchema } from './metric/test-fixture.js';
export type { MetricTestFixture } from './metric/test-fixture.js';

export { caseFolderSchema, isJsonValue } from './project/shared.js';
export type { JsonValue, RawExcerpt, SecretReference } from './project/shared.js';
export { projectManifestSchema } from './project/manifest.js';
export type { ProjectManifest } from './project/manifest.js';
export { projectResourcesSchema } from './project/resources-snapshot.js';
export type { ProjectResources } from './project/resources-snapshot.js';
export { agentResourceSchema } from './project/resources/agent.js';
export type { AgentResource } from './project/resources/agent.js';
export {
  httpRequestTemplateSchema,
  vercelSandboxSchema,
} from './project/resources/agent-transports.js';
export type { HttpRequestTemplate, VercelSandbox } from './project/resources/agent-transports.js';
export { testCaseSchema } from './project/resources/case.js';
export type { TestCase } from './project/resources/case.js';
export { datasetResourceSchema } from './project/resources/dataset.js';
export type { DatasetImportMapping, DatasetResource } from './project/resources/dataset.js';
export { metricResourceSchema } from './project/resources/metric.js';
export type { MetricResource } from './project/resources/metric.js';
export { testResourceSchema } from './project/resources/test.js';
export type { TestResource } from './project/resources/test.js';

export {
  cliFailureResultSchema,
  cliHelpArgumentSchema,
  cliHelpOptionSchema,
  cliSuccessResultSchema,
  cliErrorCatalogSchema,
  cliEventSchema,
  cliHelpSchema,
  cliResultSchema,
} from './cli/protocol.js';
export type {
  CliError,
  CliErrorCatalog,
  CliErrorDefinition,
  CliEvent,
  CliExitCode,
  CliFailureResult,
  CliHelp,
  CliResult,
  CliSuccessResult,
  CliWarning,
} from './cli/protocol.js';
export { commandRequestSchema } from './cli/command-request.js';
export type { CommandRequest } from './cli/command-request.js';
export { caseImportOptionsSchema } from './cli/command-request/test.js';
export type { CaseImportOptions } from './cli/command-request/test.js';

export {
  caseOutcomeSchema,
  invocationErrorCodeSchema,
  warningCodeSchema,
} from './eval/execution.js';
export type { CaseOutcome, InvocationErrorCode, WarningCode } from './eval/execution.js';
export { caseSelectionSchema } from './eval/selection.js';
export type { CaseSelection, CaseSelectionSummary } from './eval/selection.js';
export {
  evalOutputModeSchema,
  evalRunEffectiveCommandSchema,
  evalRunRequestSchema,
  evalRunSchema,
  evalRunSnapshotSchema,
} from './eval/run.js';
export type {
  EvalOutputMode,
  EvalRun,
  EvalRunEffectiveCommand,
  EvalRunRequest,
  EvalRunSelectedCase,
  EvalRunSnapshot,
} from './eval/run.js';
export { evalCancelRequestSchema, evalCancelResultSchema } from './eval/cancel.js';
export type { EvalCancelRequest, EvalCancelResult } from './eval/cancel.js';
export { evalEventSchema, evalFinalResultDataSchema } from './eval/event.js';
export type { EvalEvent, EvalFinalResultData, EvalRunSummary } from './eval/event.js';
export { evalEventStreamSchema } from './eval/event-stream.js';
export type { EvalEventStream } from './eval/event-stream.js';
export {
  portableProjectBundleSchema,
  cloudRunRequestSchema,
  cloudQueueMessageSchema,
} from './cloud/project-bundle.js';
export type {
  PortableProjectBundle,
  CloudRunRequest,
  CloudQueueMessage,
} from './cloud/project-bundle.js';
