import { toJsonPointer } from './json-pointer.js';

type SchemaIssue = { message: string; path: readonly PropertyKey[] };

type SchemaIssueDiagnostic = { message: string; path: string };

/**
 * Turns zod issues into the `{ message, path }` list carried in error details. Paths are JSON
 * Pointers so the CLI can point at the offending field without echoing its value.
 */
const schemaIssueDiagnostics = (issues: readonly SchemaIssue[]): SchemaIssueDiagnostic[] =>
  issues.map(({ message, path }) => ({ message, path: toJsonPointer(path) }));

export { schemaIssueDiagnostics };
