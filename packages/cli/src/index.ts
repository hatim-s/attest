export { runCli, type CliIo, type RunCliOptions } from './run-cli.js';
export {
  PROJECT_MANIFEST_FILE,
  discoverProject,
  type DiscoverProjectOptions,
  type DiscoveredProject,
} from './project/discover-project.js';
export {
  hashCanonicalContent,
  hashCanonicalJson,
  hashCanonicalJsonLines,
  serializeCanonicalJson,
  serializeCanonicalJsonLines,
  type JsonValue,
} from './project/canonical-project.js';
export {
  ProjectLoadError,
  formatProjectDiagnostic,
  type ProjectDiagnostic,
  type ProjectDiagnosticCode,
} from './project/project-errors.js';
export {
  loadProject,
  type LoadedProject,
  type ProjectContentHashes,
} from './project/load-project.js';
export {
  PROJECT_LOCK_FILE,
  ProjectTransactionError,
  acquireProjectLock,
  applyProjectMutation,
  inspectProjectLock,
  releaseProjectLock,
  unlockStaleProjectLock,
  type ProjectLockInspection,
  type ProjectMutationRequest,
  type ProjectMutationResult,
  type SemanticProjectDiff,
  type SemanticProjectOperation,
} from './project/transaction/index.js';
export {
  AttestCliError,
  createCliErrorCatalog,
  getCliErrorDefinition,
  renderCliError,
  renderCliErrorCatalog,
  serializeCliError,
  type AttestCliErrorOptions,
  type CliErrorCode,
  type SerializedCliFailure,
} from './errors.js';
export {
  CliEventSerializer,
  createCliFailureResult,
  createCliSuccessResult,
  serializeCliResult,
  type CliEventClock,
  type CliResultOptions,
} from './output/cli-protocol.js';
export {
  collectEvalEvents,
  registerEvalCommands,
  renderHumanFinalResult,
  renderHumanProgress,
  type EvalCancelExecutionContext,
  type EvalCommandServices,
  type EvalEventSource,
  type EvalRunExecutionContext,
  type RegisterEvalCommandsOptions,
} from './commands/eval/eval-command.js';
export {
  DEFAULT_EVAL_CONCURRENCY,
  DEFAULT_EVAL_TIMEOUT_MS,
  createExecutionId,
  resolveEvalRun,
  type EvalResolverOptions,
  type Immutable,
  type ResolvedEvalCaseInput,
  type ResolvedEvalMetric,
  type ResolvedEvalRun,
  type ResolvedEvalTestInput,
} from './commands/eval/eval-resolver.js';
export {
  cancelConfiguration,
  runConfiguration,
  type CancelConfigurationOptions,
  type RunConfigurationOptions,
} from './run/run-configuration.js';
export {
  generateCaseId,
  parseJsonFlag,
  readCommandRequest,
  validateCommandRequest,
  type TestCaseInput,
} from './commands/test/test-command-input.js';
export {
  inferImportFormat,
  runTabularImportAdapter,
  type ImportCommandAdapterOptions,
} from './commands/test/import/tabular-import-adapter.js';
export {
  runTestCaseListCommand,
  runTestCaseShowCommand,
  runTestListCommand,
  runTestMutationCommand,
  runTestShowCommand,
  type TestAuthoringCommand,
  type TestMutationCommandOptions,
  type TestReadCommandOptions,
} from './commands/test/test-command.js';
