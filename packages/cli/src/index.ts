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
