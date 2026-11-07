import { withCommandCleanup } from '../../shared/command-cleanup.js';
import * as Effect from 'effect/Effect';
import { isAbsolute, resolve } from 'node:path';

import {
  parseWithSchema,
  AGENT_RESOURCE_SCHEMA_ID,
  agentResourceSchema,
  type AgentResource,
  type CommandRequest,
} from '@attest/contracts';

import { LocalError } from '../../../errors/index.js';
import { withAnchored, anchoredCall } from '../../../internal/open-anchored.js';
import { schemaIssueDiagnostics } from '../../../internal/schema-issue-diagnostics.js';
import { parseJsonText, readSourceText } from '../../../internal/source-text.js';
import { isProjectPath } from '../../../project/project-path.js';
import { findCurlBodyFilePath, parseCurlCommand, type CurlImportPreview } from '../curl-parser.js';
import { CurlImportError } from '../curl-tokenizer.js';
import { assertSafeNativeAgentResource } from './resource-validation.js';
import type { ReadInput } from './types.js';

const MAX_CURL_BYTES = 1024 * 1024;

const REMOTE_SOURCE = /^https?:\/\//u;

const MAX_REMOTE_JSON_BYTES = 1024 * 1024;

const REMOTE_JSON_TIMEOUT_MS = 10_000;

/** Fetches one bounded JSON document without following redirects or reflecting its URL. */
const readRemoteJson = Effect.fn('readRemoteJson')(function* (source: string, path: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_JSON_TIMEOUT_MS);

  return yield* withCommandCleanup(
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(source, {
            redirect: 'manual',
            signal: AbortSignal.any([signal, controller.signal]),
          }),
        catch: (cause) =>
          new LocalError('cli_usage', 'Could not fetch the remote JSON source.', {
            path,
            hint: 'Use a reachable HTTP(S) JSON resource under 1 MiB.',
            cause,
          }),
      });

      if (response.body === null) {
        if (!response.ok)
          return yield* Effect.fail(
            new LocalError('cli_usage', 'The remote JSON source returned an error.', {
              path,
              details: { http_status: response.status },
            }),
          );

        return '';
      }

      const reader = response.body.getReader();

      return yield* withCommandCleanup(
        Effect.gen(function* () {
          if (!response.ok)
            return yield* Effect.fail(
              new LocalError('cli_usage', 'The remote JSON source returned an error.', {
                path,
                details: { http_status: response.status },
              }),
            );
          const chunks: Uint8Array[] = [];
          let bytes = 0;

          while (true) {
            const chunk = yield* Effect.tryPromise({
              try: () => reader.read(),
              catch: (cause) =>
                new LocalError('cli_usage', 'Could not fetch the remote JSON source.', {
                  path,
                  cause,
                }),
            });

            if (chunk.done) break;
            bytes += chunk.value.byteLength;

            if (bytes > MAX_REMOTE_JSON_BYTES)
              return yield* Effect.fail(
                new LocalError('cli_usage', 'The remote JSON source exceeds the size limit.', {
                  path,
                  details: { maximum_bytes: MAX_REMOTE_JSON_BYTES },
                }),
              );
            chunks.push(chunk.value);
          }

          return yield* Effect.try({
            try: () =>
              new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)),
            catch: (cause) =>
              new LocalError('cli_usage', 'Could not fetch the remote JSON source.', {
                path,
                cause,
              }),
          });
        }),
        [
          Effect.tryPromise({ try: () => reader.cancel(), catch: (cause) => cause }).pipe(
            Effect.interruptible,
            Effect.timeoutOption('1 second'),
            Effect.flatMap((result) =>
              result._tag === 'None'
                ? Effect.fail(new Error('Remote reader cleanup timed out.'))
                : Effect.void,
            ),
          ),
          Effect.sync(() => reader.releaseLock()),
        ],
      );
    }),
    [Effect.sync(() => clearTimeout(timer))],
  );
});

/** Imports one native agent resource without preserving its source bytes or literal secrets. */
const readImportedAgentResource = Effect.fn('readImportedAgentResource')(function* (
  source: string,
  agentId: string,
  name: string | undefined,
  workingDirectory: string,
  readStdin: ReadInput,
) {
  try {
    const text = REMOTE_SOURCE.test(source)
      ? yield* readRemoteJson(source, 'source')
      : yield* readSourceText(source, { path: 'source', readStdin, workingDirectory });

    const value = parseJsonText(text, { path: 'source' });
    const parsed = parseWithSchema(agentResourceSchema, value);

    if (!parsed.ok) {
      throw new LocalError('cli_usage', 'Imported agent JSON does not match its schema.', {
        path: 'source',
        details: { diagnostics: schemaIssueDiagnostics(parsed.error.issues) },
      });
    }

    const resource = { ...parsed.value, id: agentId, name: name?.trim() || parsed.value.name };
    assertSafeNativeAgentResource(resource);

    return resource;
  } catch (error) {
    if (error instanceof LocalError) return yield* Effect.fail(error);
    throw error;
  }
});

type CurlAgentImportRequest = Extract<
  CommandRequest,
  { command: 'agent.import'; source_type: 'curl' }
>;

/** Reads one bounded local/stdin cURL document without permitting remote source indirection. */
const readCurlDocument = Effect.fn('readCurlDocument')(function* (
  source: string,
  workingDirectory: string,
  readStdin: ReadInput,
) {
  try {
    if (REMOTE_SOURCE.test(source)) {
      throw new LocalError('cli_usage', 'Remote cURL sources are not supported.', {
        path: 'source',
        hint: 'Pass a local cURL file or `-` for stdin.',
      });
    }

    const text = yield* readSourceText(source, { path: 'source', readStdin, workingDirectory });

    if (Buffer.byteLength(text) > MAX_CURL_BYTES) {
      throw new LocalError('cli_usage', 'The cURL source exceeds the size limit.', {
        path: 'source',
        details: { maximum_bytes: MAX_CURL_BYTES },
      });
    }

    return text;
  } catch (error) {
    if (error instanceof LocalError) return yield* Effect.fail(error);
    throw error;
  }
});

/** Reads one project-contained cURL data file through a no-follow bounded descriptor. */
const readCurlBodyFile = Effect.fn('readCurlBodyFile')(function* (
  path: string,
  projectRoot: string,
  maximumBytes: number,
) {
  const candidate = resolve(projectRoot, path);

  if (path.length === 0 || isAbsolute(path) || !isProjectPath(projectRoot, candidate))
    return yield* Effect.fail(
      new LocalError('cli_usage', 'The cURL body file must be inside the project.', {
        path: 'source',
        details: { diagnostic: 'file_body_outside_project' },
      }),
    );

  return yield* withAnchored(candidate, { kind: 'file' as const, root: projectRoot }, (opened) =>
    Effect.gen(function* () {
      if (opened.identity.size > BigInt(maximumBytes))
        return yield* Effect.fail(
          new LocalError('cli_usage', 'Could not safely read the cURL body file.', {
            path: 'source',
            details: { diagnostic: 'unsafe_file_body' },
          }),
        );
      const chunks: Buffer[] = [];
      let bytes = 0;

      for (;;) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - bytes));

        const read = yield* anchoredCall('read', candidate, () =>
          opened.handle.read(chunk, 0, chunk.length, bytes),
        );

        if (read.bytesRead === 0) break;
        bytes += read.bytesRead;

        if (bytes > maximumBytes)
          return yield* Effect.fail(
            new LocalError('cli_usage', 'Could not safely read the cURL body file.', {
              path: 'source',
              details: { diagnostic: 'unsafe_file_body' },
            }),
          );
        chunks.push(chunk.subarray(0, read.bytesRead));
      }

      return yield* Effect.try({
        try: () => new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)),
        catch: (cause) =>
          new LocalError('cli_usage', 'Could not safely read the cURL body file.', {
            path: 'source',
            details: { diagnostic: 'unsafe_file_body' },
            cause,
          }),
      });
    }),
  ).pipe(
    Effect.mapError((cause) =>
      cause instanceof LocalError
        ? cause
        : new LocalError('cli_usage', 'Could not safely read the cURL body file.', {
            path: 'source',
            details: { diagnostic: 'unsafe_file_body' },
            cause,
          }),
    ),
  );
});

/** Converts one inert cURL request into a canonical direct or polling agent resource. */
const createImportedCurlAgentResource = Effect.fn('createImportedCurlAgentResource')(function* (
  request: CurlAgentImportRequest,
  source: string,
  projectRoot: string,
) {
  try {
    let parsedCurl: ReturnType<typeof parseCurlCommand>;

    try {
      const bodyFilePath = findCurlBodyFilePath(source);

      const bodyFile =
        bodyFilePath === undefined
          ? undefined
          : {
              path: bodyFilePath,
              text: yield* readCurlBodyFile(
                bodyFilePath,
                projectRoot,
                Math.min(request.limits?.request_bytes ?? MAX_CURL_BYTES, MAX_CURL_BYTES),
              ),
            };

      parsedCurl = parseCurlCommand(source, {
        bodyFile,
        headerSecrets: request.header_env,
        querySecrets: request.query_env,
        placeholders: request.placeholders?.map((mapping) => ({
          targetPointer: mapping.target_pointer,
          inputPointer: mapping.input_pointer,
        })),
      });
    } catch (error: unknown) {
      if (error instanceof CurlImportError) {
        throw new LocalError('cli_usage', error.message, {
          path: 'source',
          hint: 'Use literal HTTP request data and explicit environment-backed secret mappings.',
          details: { diagnostics: error.diagnostics },
        });
      }

      throw error;
    }

    const transport =
      request.polling === undefined
        ? {
            kind: 'http' as const,
            lifecycle: 'external' as const,
            response_mode: 'mapped' as const,
            request: parsedCurl.request,
            extraction: request.extraction,
          }
        : {
            kind: 'polling' as const,
            lifecycle: 'external' as const,
            submit: parsedCurl.request,
            extraction: request.extraction,
            ...request.polling,
          };

    let candidate: AgentResource = {
      schema: AGENT_RESOURCE_SCHEMA_ID,
      id: request.as,
      name: request.name?.trim() || request.as,
      transport,
    };

    if (request.timeouts !== undefined) {
      candidate = { ...candidate, timeouts: request.timeouts };
    }

    if (request.retry !== undefined) {
      candidate = { ...candidate, retry: request.retry };
    }

    if (request.limits !== undefined) {
      candidate = { ...candidate, limits: request.limits };
    }

    const headerNames = Object.keys(request.header_env ?? {});
    const queryNames = Object.keys(request.query_env ?? {});

    if (headerNames.length + queryNames.length > 0) {
      let redaction: NonNullable<AgentResource['redaction']> = {};

      if (request.header_env !== undefined) redaction = { ...redaction, headers: headerNames };

      if (request.query_env !== undefined) redaction = { ...redaction, query: queryNames };
      candidate = { ...candidate, redaction: redaction };
    }

    const parsed = parseWithSchema(agentResourceSchema, candidate);

    if (!parsed.ok) {
      throw new LocalError('cli_usage', 'The cURL mapping does not match the agent schema.', {
        path: 'source',
        details: { diagnostics: schemaIssueDiagnostics(parsed.error.issues) },
      });
    }

    assertSafeNativeAgentResource(parsed.value);

    return { agent: parsed.value, preview: parsedCurl.preview } satisfies {
      agent: AgentResource;
      preview: CurlImportPreview;
    };
  } catch (error) {
    if (error instanceof LocalError) return yield* Effect.fail(error);
    throw error;
  }
});

export { createImportedCurlAgentResource, readCurlDocument, readImportedAgentResource };
