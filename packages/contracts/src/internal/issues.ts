import * as Schema from 'effect/Schema';
import * as SchemaIssue from 'effect/SchemaIssue';
import * as Predicate from 'effect/Predicate';

/** Stable diagnostics for consumers; native cause remains available for detailed inspection. */
type SchemaDiagnostic = {
  readonly code: SchemaIssue.Issue['_tag'];
  readonly path: readonly PropertyKey[];
  readonly message: string;
};

type ContractIssue = { path: string; message: string };

/** Projects native issue trees without interpreting display text. */
// BOUNDARY: Native Standard Schema paths admit property keys or key-bearing path segments.
const projectIssues = (issue: SchemaIssue.Issue): SchemaDiagnostic[] => {
  const formatter = SchemaIssue.makeFormatterStandardSchemaV1();

  const visit = (node: SchemaIssue.Issue, path: readonly PropertyKey[]): SchemaDiagnostic[] => {
    switch (node._tag) {
      case 'Pointer':
        return visit(node.issue, [...path, ...node.path]);
      case 'Encoding':
        return visit(node.issue, path);
      case 'Filter':
        return formatter(node).issues.map((entry) => ({
          code: 'Filter',
          path: [
            ...path,
            ...(entry.path ?? []).map((segment) =>
              Predicate.isPropertyKey(segment) ? segment : segment.key,
            ),
          ],
          message: entry.message,
        }));
      case 'Composite':
        return node.issues.flatMap((child) => visit(child, path));
      case 'AnyOf':
        if (node.issues.length) return node.issues.flatMap((child) => visit(child, path));
    }

    return formatter(node).issues.map((entry) => ({
      code: node._tag,
      path: [
        ...path,
        ...(entry.path ?? []).map((segment) =>
          Predicate.isPropertyKey(segment) ? segment : segment.key,
        ),
      ],
      message: entry.message,
    }));
  };

  return visit(issue, []);
};

/** One validation failure shape shared by Result, Effect and synchronous decoding. */
class SchemaDecodeError extends Error {
  readonly _tag = 'SchemaDecodeError';
  readonly issues: readonly SchemaDiagnostic[];
  /** Keeps native validation details alongside safe consumer diagnostics. */
  constructor(readonly cause: Schema.SchemaError) {
    super(cause.message, { cause });
    this.name = 'SchemaDecodeError';
    this.issues = projectIssues(cause.issue);
  }
}

/** Renders path-bearing diagnostics for protocol responses. */
const formatContractIssues = (issues: readonly SchemaDiagnostic[]): ContractIssue[] =>
  issues.map((issue) => ({
    path: issue.path.length ? issue.path.map(String).join('.') : '$',
    message: issue.message,
  }));

export {
  SchemaDecodeError,
  projectIssues,
  formatContractIssues,
  type SchemaDiagnostic,
  type ContractIssue,
};
