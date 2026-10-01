import { AttestError, type ProjectResources, type JsonValue } from '@attest/contracts';

type EvalResolutionErrorCode =
  'cli_usage' | 'project_invalid' | 'project_changed' | 'resource_not_found';

type EvalResolutionErrorOptions = ErrorOptions & {
  details?: JsonValue;
  hint?: string;
  path?: string;
};

/** Carries pure evaluation resolution failure details without assigning CLI exit behavior. */
class EvalResolutionError extends AttestError {
  readonly code: EvalResolutionErrorCode;
  readonly details: JsonValue | undefined;
  readonly hint: string | undefined;
  readonly path: string | undefined;

  constructor(
    code: EvalResolutionErrorCode,
    message: string,
    options?: EvalResolutionErrorOptions,
  ) {
    super(code, message, options);
    this.code = code;
    this.details = options?.details;
    this.hint = options?.hint;
    this.path = options?.path;
  }
}

type ProjectContentHashes = {
  agents: Readonly<Record<string, string>>;
  datasets: Readonly<Record<string, { data: string; metadata: string }>>;
  manifest: string;
  metrics: Readonly<Record<string, string>>;
  tests: Readonly<Record<string, string>>;
};

type ResolutionProject = ProjectResources & {
  contentHashes: ProjectContentHashes;
  projectHash: string;
};

export {
  EvalResolutionError,
  type EvalResolutionErrorCode,
  type EvalResolutionErrorOptions,
  type ProjectContentHashes,
  type ResolutionProject,
};
