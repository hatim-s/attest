import { AttestCliError, type CliErrorCode } from '../errors/index.js';

type ProjectDiagnosticCode =
  | 'content_hash_mismatch'
  | 'json_invalid'
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

/** Formats one diagnostic without including authored values or parser excerpts. */
const formatProjectDiagnostic = ({ code, message, path, source }: ProjectDiagnostic): string =>
  `${source}${path === undefined ? '' : `:${path}`} [${code}] ${message}`;

/** Carries every safe, source-addressed failure found while reading one project. */
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

export {
  ProjectLoadError,
  formatProjectDiagnostic,
  type ProjectDiagnostic,
  type ProjectDiagnosticCode,
};
