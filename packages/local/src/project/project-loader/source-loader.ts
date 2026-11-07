import * as Effect from 'effect/Effect';
import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import {
  anchoredCall,
  withAnchored,
  AnchoredCleanup,
  AnchoredFileFailure,
} from '../../internal/open-anchored.js';
import { parseWithSchemaSync, parseWithSchema } from '@attest/contracts';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import * as Schema from 'effect/Schema';

import type { JsonValue } from '@attest/contracts';

import { contentHash } from '@attest/core';

import { toJsonPointer } from '../../internal/json-pointer.js';
import type { ProjectDiagnostic } from '../project-errors.js';
import { isProjectPath } from '../project-path.js';
import type { LoadedJsonResource } from './types.js';

/** Reads one project-relative file only after lexical and realpath containment checks. */
const readProjectSource = Effect.fn('readProjectSource')(function* (
  root: string,
  source: string,
): Effect.fn.Return<
  { diagnostics: ProjectDiagnostic[]; text?: string },
  | import('../../internal/open-anchored.js').AnchoredCleanupFailure
  | import('../../internal/open-anchored.js').AnchoredFileFailure
> {
  const candidate = resolve(root, source);

  if (!isProjectPath(root, candidate))
    return {
      diagnostics: [
        { code: 'path_unsafe', message: 'path resolves outside the project root', source },
      ],
    };

  const resolved = yield* Effect.result(
    anchoredCall('realpath', candidate, () => realpath(candidate)),
  );

  if (resolved._tag === 'Failure') {
    const missing = resolved.failure.code === 'ENOENT';

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

  if (!isProjectPath(root, resolved.success))
    return {
      diagnostics: [
        {
          code: 'path_unsafe',
          message: 'path resolves through a symlink outside the project root',
          source,
        },
      ],
    };

  // Preserve accepted in-root aliases, then read only through the validated descriptor.
  return yield* withAnchored(resolved.success, { root, kind: 'file' }, (entry) =>
    anchoredCall('readFile', source, () => entry.handle.readFile('utf8')),
  ).pipe(
    Effect.map((text) => ({ diagnostics: [], text })),
    Effect.catchCause((cause) => {
      // A diagnostic-valued read failure must not erase cleanup uncertainty or runtime causes.
      if (
        Cause.hasDies(cause) ||
        Cause.hasInterrupts(cause) ||
        Context.getOrUndefined(Cause.annotations(cause), AnchoredCleanup) !== undefined
      )
        return Effect.failCause(cause);
      const reason = cause.reasons.find(Cause.isFailReason);

      if (reason === undefined || !(reason.error instanceof AnchoredFileFailure))
        return Effect.failCause(cause);

      return Effect.succeed({
        diagnostics: [
          {
            code: 'source_unreadable' as const,
            message:
              reason.error.operation === 'validateKind'
                ? 'authored path is not a regular file'
                : 'authored file is not readable',
            source,
          },
        ],
      });
    }),
  );
});

/** Parses JSON without forwarding parser excerpts that may contain authored secret values. */
type ParsedProjectJson = { diagnostics: ProjectDiagnostic[]; value?: JsonValue };

const parseJson = (text: string, source: string, path?: string): ParsedProjectJson => {
  try {
    return { diagnostics: [], value: parseWithSchemaSync(Schema.Json, JSON.parse(text)) };
  } catch {
    return {
      diagnostics: [{ code: 'json_invalid', message: 'could not parse JSON', path, source }],
    };
  }
};

const schemaDiagnostics = (
  source: string,
  issues: readonly { message: string; path: readonly PropertyKey[] }[],
  prefix: readonly PropertyKey[] = [],
): ProjectDiagnostic[] =>
  issues.map((issue) => ({
    code: 'schema_invalid',
    message: issue.message,
    path: toJsonPointer([...prefix, ...issue.path]),
    source,
  }));

/** Loads, validates, and hashes one canonical JSON resource while retaining every issue. */
const loadJsonResource = Effect.fn('loadJsonResource')(function* <Value>(
  root: string,
  source: string,
  expectedHash: string | undefined,
  schema: Schema.ConstraintDecoder<Value>,
): Effect.fn.Return<
  LoadedJsonResource<Value>,
  | import('../../internal/open-anchored.js').AnchoredCleanupFailure
  | import('../../internal/open-anchored.js').AnchoredFileFailure
> {
  const loaded = yield* readProjectSource(root, source);

  if (loaded.text === undefined) return { diagnostics: loaded.diagnostics, source };
  const parsed = parseJson(loaded.text, source);

  if (parsed.value === undefined) return { diagnostics: parsed.diagnostics, source };

  const hash = contentHash(parsed.value);
  const diagnostics = [...parsed.diagnostics];

  if (expectedHash !== undefined && expectedHash !== hash) {
    diagnostics.push({
      code: 'content_hash_mismatch',
      message: `canonical SHA-256 is ${hash}, manifest records ${expectedHash}`,
      source,
    });
  }

  const validated = parseWithSchema(schema, parsed.value);

  if (!validated.ok) {
    diagnostics.push(...schemaDiagnostics(source, validated.error.issues));

    return { diagnostics, hash, source };
  }

  return { diagnostics, hash, source, value: validated.value };
});

export { loadJsonResource, parseJson, readProjectSource, schemaDiagnostics };
