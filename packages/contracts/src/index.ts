export { AttestError } from './errors/attest-error.js';
export { agentRequestSchema, agentResponseSchema } from './agent/protocol.js';
export type {
  AgentErrorResponse,
  AgentRequest,
  AgentResponse,
  AgentSuccessResponse,
} from './agent/protocol.js';
export type { CaseOutcome, InvocationErrorCode, RawExcerpt } from './eval/execution.js';
export {
  assertionCheckSchema,
  metricDefinitionSchema,
  metricRequestSchema,
  metricResultSchema,
  spanFilterSchema,
  toolArgumentMatcherSchema,
} from './metric/protocol.js';
export type {
  AssertionCheck,
  JsonValue,
  LeafAssertionCheck,
  MetricDefinition,
  MetricRequest,
  MetricResult,
  SpanFilter,
  ToolArgumentMatcher,
} from './metric/protocol.js';
export {
  parseAgentRequest,
  parseAgentResponse,
  parseMetricRequest,
  parseMetricResult,
  parseTrace,
} from './schema/parse.js';
export type { ContractIssue, ContractWarning, ParseReport } from './schema/parse.js';
export type { Result } from './cli/result.js';
export {
  jsonlBridgeCancelSchema,
  jsonlBridgeCancelledSchema,
  jsonlBridgeInputSchema,
  jsonlBridgeOutputSchema,
  jsonlBridgeRequestSchema,
  jsonlBridgeResponseSchema,
} from './agent/managed-transport.js';
export type { JsonlBridgeInput, JsonlBridgeOutput } from './agent/managed-transport.js';
export { CONTRACT_JSON_SCHEMAS, serializeContractSchema } from './schema/json-schema.js';
export { spanKindSchema, spanSchema, traceSchema } from './trace/protocol.js';
export type { Span, SpanKind, Trace } from './trace/protocol.js';
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
  DATASET_SCHEMA_ID,
  DATASET_SCHEMA_VERSION,
  EVAL_RUN_SCHEMA_ID,
  EVAL_RUN_SCHEMA_VERSION,
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
} from './schema/identifiers.js';
export {
  agentEvidenceLimitsSchema,
  agentResourceSchema,
  agentTimeoutPolicySchema,
  agentTransportSchema,
  httpRequestTemplateSchema,
  redactionPolicySchema,
  responseExtractionSchema,
} from './project/resources/agent.js';
export type {
  AgentEvidenceLimits,
  AgentResource,
  AgentTimeoutPolicy,
  AgentTransport,
  HttpRequestTemplate,
  RedactionPolicy,
  ResponseExtraction,
} from './project/resources/agent.js';
export { caseMetricOverrideSchema, testCaseSchema } from './project/resources/case.js';
export type { CaseMetricOverride, TestCase } from './project/resources/case.js';
export {
  cliCommandSchema,
  cliErrorCatalogSchema,
  cliErrorDefinitionSchema,
  cliErrorSchema,
  cliEventSchema,
  cliExitCodeSchema,
  cliFailureResultSchema,
  cliHelpArgumentSchema,
  cliHelpCommandSchema,
  cliHelpOptionSchema,
  cliHelpSchema,
  cliResultSchema,
  cliSuccessResultSchema,
  cliWarningSchema,
} from './cli/protocol.js';
export type {
  CliError,
  CliErrorCatalog,
  CliErrorDefinition,
  CliEvent,
  CliExitCode,
  CliFailureResult,
  CliHelp,
  CliHelpArgument,
  CliHelpCommand,
  CliHelpOption,
  CliResult,
  CliSuccessResult,
  CliWarning,
} from './cli/protocol.js';
export { caseImportOptionsSchema, commandRequestSchema } from './cli/command-request.js';
export type { CaseImportOptions, CommandRequest } from './cli/command-request.js';
export {
  datasetImportDestinationSchema,
  datasetImportMappingSchema,
  datasetImportProvenanceSchema,
  datasetResourceSchema,
} from './project/resources/dataset.js';
export type {
  DatasetImportMapping,
  DatasetImportProvenance,
  DatasetResource,
} from './project/resources/dataset.js';
export { metricResourceSchema, metricResultExtractionSchema } from './project/resources/metric.js';
export type { MetricResource, MetricResultExtraction } from './project/resources/metric.js';
export {
  METRIC_PRESETS,
  findMetricPreset,
  metricPresetIdSchema,
  metricPresetSchema,
} from './metric/presets.js';
export type { MetricPreset, MetricPresetId } from './metric/presets.js';
export { metricTestFixtureSchema } from './metric/test-fixture.js';
export type { MetricTestFixture } from './metric/test-fixture.js';
export {
  datasetManifestEntrySchema,
  loadedDatasetSchema,
  projectManifestSchema,
  projectResourcesSchema,
} from './project/manifest.js';
export type { LoadedDataset, ProjectManifest, ProjectResources } from './project/manifest.js';
export {
  datasetAttachmentSchema,
  testMetricReferenceSchema,
  testPassGateSchema,
  testResourceSchema,
} from './project/resources/test.js';
export type {
  DatasetAttachment,
  TestMetricReference,
  TestPassGate,
  TestResource,
} from './project/resources/test.js';
export {
  durationMillisecondsSchema,
  executionDefaultsSchema,
  jsonPointerSchema,
  projectIdSchema,
  relativePathSchema,
  resourceIdSchema,
  retryPolicySchema,
  secretReferenceSchema,
  sha256Schema,
} from './project/shared.js';
export type { ExecutionDefaults, SecretReference } from './project/shared.js';
export {
  evalOutputModeSchema,
  evalRunEffectiveCommandSchema,
  evalRunIdSchema,
  evalRunRequestSchema,
  evalRunSchema,
  evalRunSelectedCaseSchema,
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
export {
  evalCancelRequestSchema,
  evalCancelResultPayloadSchema,
  evalCancelResultSchema,
} from './eval/cancel.js';
export type {
  EvalCancelRequest,
  EvalCancelResult,
  EvalCancelResultPayload,
} from './eval/cancel.js';
export {
  evalCaseCompletedEventSchema,
  evalCaseStartedEventSchema,
  evalEventSchema,
  evalEventStreamSchema,
  evalFinalResultDataSchema,
  evalResultEventSchema,
  evalRunCompletedEventSchema,
  evalRunStartedEventSchema,
  evalRunSummarySchema,
} from './eval/event.js';
export type {
  EvalEvent,
  EvalEventStream,
  EvalFinalResultData,
  EvalRunSummary,
} from './eval/event.js';
export {
  webSocketAttemptEvidenceSchema,
  webSocketConnectionModeSchema,
  webSocketCorrelatedMessageSchema,
  webSocketErrorClassificationSchema,
  webSocketEvidenceClassificationSchema,
  webSocketInvocationRequestSchema,
  webSocketRequestIdSchema,
  webSocketTransportSchema,
} from './agent/websocket-contract.js';
export type {
  WebSocketAttemptEvidence,
  WebSocketConnectionMode,
  WebSocketCorrelatedMessage,
  WebSocketErrorClassification,
  WebSocketEvidenceClassification,
  WebSocketInvocationRequest,
  WebSocketTransport,
} from './agent/websocket-contract.js';
