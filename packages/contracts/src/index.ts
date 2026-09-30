export { AttestError } from './errors/attest-error.js';
export { agentRequestSchema, agentResponseSchema } from './agent/protocol.js';
export type {
  AgentErrorResponse,
  AgentRequest,
  AgentResponse,
  AgentSuccessResponse,
} from './agent/protocol.js';
export type { CaseOutcome, InvocationErrorCode } from './eval/execution.js';
export {
  assertionCheckSchema,
  metricRequestSchema,
  metricResultSchema,
  spanFilterSchema,
  toolArgumentMatcherSchema,
} from './metric/protocol.js';
export type {
  AssertionCheck,
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
export type { Result } from './result.js';
export {
  jsonlBridgeCancelSchema,
  jsonlBridgeCancelledSchema,
  jsonlBridgeInputSchema,
  jsonlBridgeOutputSchema,
  jsonlBridgeRequestSchema,
  jsonlBridgeResponseSchema,
} from './agent/jsonl-bridge.js';
export type { JsonlBridgeInput, JsonlBridgeOutput } from './agent/jsonl-bridge.js';
export { CONTRACT_JSON_SCHEMAS, serializeContractSchema } from './schema/json-schema.js';
export { spanKindSchema, spanSchema, traceSchema } from './trace/protocol.js';
export type { Span, SpanKind, Trace } from './trace/protocol.js';
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
} from './schema/identifiers.js';
export {
  agentEvidenceLimitsSchema,
  agentResourceSchema,
  agentTimeoutPolicySchema,
  redactionPolicySchema,
} from './project/resources/agent.js';
export type {
  AgentEvidenceLimits,
  AgentResource,
  AgentTimeoutPolicy,
  RedactionPolicy,
} from './project/resources/agent.js';
export {
  agentTransportSchema,
  httpRequestTemplateSchema,
  responseExtractionSchema,
  vercelSandboxSchema,
} from './project/resources/agent-transports.js';
export type {
  AgentTransport,
  HttpRequestTemplate,
  ResponseExtraction,
  VercelSandbox,
} from './project/resources/agent-transports.js';
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
export { commandRequestSchema } from './cli/command-request.js';
export type { CommandRequest } from './cli/command-request.js';
export { caseImportOptionsSchema } from './cli/command-request/test.js';
export type { CaseImportOptions } from './cli/command-request/test.js';
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
export { projectManifestSchema } from './project/manifest.js';
export type { ProjectManifest } from './project/manifest.js';
export { projectResourcesSchema } from './project/resources-snapshot.js';
export type { ProjectResources } from './project/resources-snapshot.js';
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
  caseFolderSchema,
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
export type {
  ExecutionDefaults,
  JsonValue,
  RawExcerpt,
  SecretReference,
} from './project/shared.js';
export {
  evalExecutionConfigSchema,
  evalHookCommandSchema,
  evalHooksSchema,
  evalWorkerDirectorySchema,
  evalWorkersSchema,
} from './project/eval-execution.js';
export type {
  EvalExecutionConfig,
  EvalHookCommand,
  EvalHooks,
  EvalWorkers,
} from './project/eval-execution.js';
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
  evalFinalResultDataSchema,
  evalResultEventSchema,
  evalRunCompletedEventSchema,
  evalRunStartedEventSchema,
  evalRunSummarySchema,
} from './eval/event.js';
export type { EvalEvent, EvalFinalResultData, EvalRunSummary } from './eval/event.js';
export { evalEventStreamSchema } from './eval/event-stream.js';
export type { EvalEventStream } from './eval/event-stream.js';
export {
  webSocketConnectionModeSchema,
  webSocketCorrelatedMessageSchema,
  webSocketInvocationRequestSchema,
  webSocketTransportSchema,
} from './agent/websocket-contract.js';
export type {
  WebSocketCorrelatedMessage,
  WebSocketInvocationRequest,
  WebSocketTransport,
} from './agent/websocket-contract.js';
export {
  webSocketAttemptEvidenceSchema,
  webSocketErrorClassificationSchema,
  webSocketEvidenceClassificationSchema,
} from './agent/websocket-evidence.js';
export type {
  WebSocketAttemptEvidence,
  WebSocketErrorClassification,
} from './agent/websocket-evidence.js';

export {
  caseSelectionSchema,
  caseSelectionSummarySchema,
  type CaseSelection,
  type CaseSelectionSummary,
} from './eval/selection.js';
