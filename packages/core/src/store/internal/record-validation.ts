import { SchemaDecodeError } from '@attest/contracts';
import { parseWithSchema, isNumber } from '@attest/contracts';
import * as Schema from 'effect/Schema';

/** Either the validated record or every structural violation, prefixed with its field path. */
type RecordParseResult<T> = { ok: true; value: T } | { ok: false; violations: string[] };

const formatPath = (prefix: string, path: readonly PropertyKey[]): string =>
  path.reduce<string>(
    (current, segment) =>
      isNumber(segment) ? `${current}[${segment}]` : `${current}.${String(segment)}`,
    prefix,
  );

/** Renders native schema issues as field-path violations, so an operator sees every broken field at once. */
const formatRecordIssues = (issues: SchemaDecodeError['issues'], path: string): string[] =>
  issues.flatMap((issue) => {
    const location = formatPath(path, issue.path);

    if (issue.code === 'UnexpectedKey') return [`${location} is forbidden`];

    return [`${location} ${issue.message}`];
  });

/**
 * Persisted JSON drops undefined properties, so validation does too. Without this, strict record
 * branches would reject `{ errorCode: undefined }` on a completed case that stores identically to `{}`.
 */
type RecordCandidate = { value: unknown };

// BOUNDARY: Record inputs keep their untrusted leaf values while undefined object properties are omitted before schema validation.
const withoutUndefinedProperties = (value: unknown): RecordCandidate => {
  if (Array.isArray(value))
    return { value: value.map((entry) => withoutUndefinedProperties(entry).value) };

  if (value === null || typeof value !== 'object') return { value };

  return {
    value: Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, withoutUndefinedProperties(entry).value]),
    ),
  };
};

/**
 * Validates a host's record submission against its owner schema and keeps every violation, so a
 * store can reject the whole case before opening a transaction.
 */
// BOUNDARY: Store submissions are checked by their owner schema after omitting absent optional object fields.
const parseRecord = <T>(
  schema: Schema.ConstraintDecoder<T>,
  value: unknown,
  path: string,
): RecordParseResult<T> => {
  const parsed = parseWithSchema(schema, withoutUndefinedProperties(value).value);

  if (parsed.ok) return { ok: true, value: parsed.value };

  return { ok: false, violations: formatRecordIssues(parsed.error.issues, path) };
};

export { formatRecordIssues, parseRecord, type RecordParseResult };
