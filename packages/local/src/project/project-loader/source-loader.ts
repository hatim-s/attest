import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { hashCanonicalJson, type JsonValue } from '../canonical-project.js';
import type { ProjectDiagnostic } from '../project-errors.js';
import { isProjectPath } from '../project-path.js';
import type { LoadedJsonResource, RuntimeSchema, SchemaIssue } from './types.js';

const getErrorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof Reflect.get(error, 'code') === 'string'
    ? (Reflect.get(error, 'code') as string)
    : undefined;

const pointerEscape = (segment: PropertyKey): string =>
  String(segment).replaceAll('~', '~0').replaceAll('/', '~1');

const toJsonPointer = (path: readonly PropertyKey[]): string =>
  path.length === 0 ? '' : `/${path.map(pointerEscape).join('/')}`;

/** Reads one project-relative file only after lexical and realpath containment checks. */
const readProjectSource = async (
  root: string,
  source: string,
): Promise<{ diagnostics: ProjectDiagnostic[]; text?: string }> => {
  const candidate = resolve(root, source);
  if (!isProjectPath(root, candidate)) {
    return {
      diagnostics: [
        { code: 'path_unsafe', message: 'path resolves outside the project root', source },
      ],
    };
  }

  let resolvedSource: string;
  try {
    resolvedSource = await realpath(candidate);
  } catch (error: unknown) {
    const missing = getErrorCode(error) === 'ENOENT';
    return {
      diagnostics: [
        {
          code: missing ? 'source_missing' : 'source_unreadable',
          message: missing ? 'authored file does not exist' : 'authored file is not readable',
          source,
        },
      ],
    };
  }

  if (!isProjectPath(root, resolvedSource)) {
    return {
      diagnostics: [
        {
          code: 'path_unsafe',
          message: 'path resolves through a symlink outside the project root',
          source,
        },
      ],
    };
  }

  try {
    if (!(await stat(resolvedSource)).isFile()) {
      return {
        diagnostics: [
          { code: 'source_unreadable', message: 'authored path is not a regular file', source },
        ],
      };
    }
    return { diagnostics: [], text: await readFile(resolvedSource, 'utf8') };
  } catch {
    return {
      diagnostics: [
        { code: 'source_unreadable', message: 'authored file is not readable', source },
      ],
    };
  }
};

/** Parses JSON without forwarding parser excerpts that may contain authored secret values. */
const parseJson = (
  text: string,
  source: string,
  path?: string,
): { diagnostics: ProjectDiagnostic[]; value?: JsonValue } => {
  try {
    return { diagnostics: [], value: JSON.parse(text) as JsonValue };
  } catch {
    return {
      diagnostics: [{ code: 'json_invalid', message: 'could not parse JSON', path, source }],
    };
  }
};

const schemaDiagnostics = (
  source: string,
  issues: readonly SchemaIssue[],
  prefix: readonly PropertyKey[] = [],
): ProjectDiagnostic[] =>
  issues.map((issue) => ({
    code: 'schema_invalid',
    message: issue.message,
    path: toJsonPointer([...prefix, ...issue.path]),
    source,
  }));

/** Loads, validates, and hashes one canonical JSON resource while retaining every issue. */
const loadJsonResource = async <Value>(
  root: string,
  source: string,
  expectedHash: string | undefined,
  schema: RuntimeSchema<Value>,
  hashValue: (value: JsonValue) => string = hashCanonicalJson,
): Promise<LoadedJsonResource<Value>> => {
  const loaded = await readProjectSource(root, source);
  if (loaded.text === undefined) return { diagnostics: loaded.diagnostics, source };
  const parsed = parseJson(loaded.text, source);
  if (parsed.value === undefined) return { diagnostics: parsed.diagnostics, source };

  const hash = hashValue(parsed.value);
  const diagnostics = [...parsed.diagnostics];
  if (expectedHash !== undefined && expectedHash !== hash) {
    diagnostics.push({
      code: 'content_hash_mismatch',
      message: `canonical SHA-256 is ${hash}, manifest records ${expectedHash}`,
      source,
    });
  }

  const validated = schema.safeParse(parsed.value);
  if (!validated.success) {
    diagnostics.push(...schemaDiagnostics(source, validated.error.issues));
    return { diagnostics, hash, rawValue: parsed.value, source };
  }
  return { diagnostics, hash, rawValue: parsed.value, source, value: validated.data };
};

export { loadJsonResource, parseJson, readProjectSource, schemaDiagnostics, toJsonPointer };
