import { AttestCliError, type CliErrorCode } from '../errors.js';

type ProjectDiagnosticCode =
  | 'content_hash_mismatch'
  | 'json_invalid'
  | 'legacy_v1'
  | 'path_unsafe'
  | 'source_missing'
  | 'source_unreadable'
  | 'schema_invalid';

type ProjectDiagnostic = {
  code: ProjectDiagnosticCode;
  message: string;
  path?: string;
  source: string;
};

type ProjectLoadErrorOptions = ErrorOptions & {
  hint?: string;
  path?: string;
  summaryOnly?: boolean;
};

const BREAKING_V2_MESSAGE = 'Attest v2 does not execute v1 configuration or project inputs.';
const BREAKING_V2_HINT =
  'Create a v2 project with `attest project init`; use `attest eval run` as the only execution command.';

/** Formats one diagnostic without including authored values or parser excerpts. */
const formatProjectDiagnostic = ({ code, message, path, source }: ProjectDiagnostic): string =>
  `${source}${path === undefined ? '' : `:${path}`} [${code}] ${message}`;

/** Carries every safe, source-addressed failure found while reading one v2 project. */
class ProjectLoadError extends AttestCliError {
  readonly diagnostics: readonly ProjectDiagnostic[];

  constructor(
    code: Extract<CliErrorCode, 'project_invalid' | 'project_not_found' | 'project_read_failed'>,
    summary: string,
    diagnostics: readonly ProjectDiagnostic[],
    options?: ProjectLoadErrorOptions,
  ) {
    const detail = diagnostics.map(formatProjectDiagnostic).join('\n');
    const safeDiagnostics = [...diagnostics]
      .sort((left, right) =>
        [left.source, left.path ?? '', left.code, left.message]
          .join('\0')
          .localeCompare([right.source, right.path ?? '', right.code, right.message].join('\0')),
      )
      .map(({ code: diagnosticCode, message, path, source }) => ({
        code: diagnosticCode,
        message,
        source,
        ...(path === undefined ? {} : { path }),
      }));
    super(code, options?.summaryOnly || detail.length === 0 ? summary : `${summary}\n${detail}`, {
      cause: options?.cause,
      hint: options?.hint,
      path: options?.path,
      details: { diagnostics: safeDiagnostics },
    });
    this.diagnostics = diagnostics;
  }
}

/** Creates the single stable rejection used for every recognized v1 project input. */
const createLegacyV1ProjectError = (
  code: Extract<CliErrorCode, 'project_invalid' | 'project_not_found'>,
  source: string,
): ProjectLoadError =>
  new ProjectLoadError(
    code,
    BREAKING_V2_MESSAGE,
    [{ code: 'legacy_v1', message: 'legacy v1 input is not supported', source }],
    { hint: BREAKING_V2_HINT, path: source, summaryOnly: true },
  );

export {
  BREAKING_V2_HINT,
  BREAKING_V2_MESSAGE,
  ProjectLoadError,
  createLegacyV1ProjectError,
  formatProjectDiagnostic,
  type ProjectDiagnostic,
  type ProjectDiagnosticCode,
};
