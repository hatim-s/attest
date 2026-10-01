export { CaseSelectionError, selectCases } from './select-cases.js';
export {
  resolveEvalRun,
  type ResolvedEvalCaseInput,
  type ResolvedEvalRun,
  type EvalResolverOptions,
} from './eval-resolver.js';
export {
  EvalResolutionError,
  type ResolutionProject,
  type ProjectContentHashes,
} from './resolution-project.js';
export { resolvePortableProject } from './portable-project.js';
export {
  datasetMetadataForHash,
  hashCanonicalContent,
  hashCanonicalJsonLines,
  hashDatasetMetadata,
  hashProjectManifest,
  serializeCanonicalJsonLines,
} from './canonical-project.js';
export type { ResolvedEvalMetric } from './eval-case-expansion.js';
