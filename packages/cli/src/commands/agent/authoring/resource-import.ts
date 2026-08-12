import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import {
  AGENT_RESOURCE_SCHEMA_ID,
  agentResourceSchema,
  type AgentResource,
  type CommandRequest,
} from '@attest/contracts';

import { AttestCliError } from '../../../errors/index.js';
import { isProjectPath } from '../../../project/project-path.js';
import {
  CurlImportError,
  findCurlBodyFilePath,
  parseCurlCommand,
  type CurlImportPreview,
} from '../import/curl/index.js';
import { readJsonDocument, requestDiagnostics } from './json-source.js';
import { assertSafeNativeAgentResource } from './resource-validation.js';
import type { ReadInput } from './types.js';

const MAX_CURL_BYTES = 1024 * 1024;

/** Imports one native agent resource without preserving its source bytes or literal secrets. */
const readImportedAgentResource = async (
  source: string,
  agentId: string,
  name: string | undefined,
  workingDirectory: string,
  readStdin: ReadInput,
): Promise<AgentResource> => {
  const value = await readJsonDocument(source, workingDirectory, readStdin, 'source', true);
  const parsed = agentResourceSchema.safeParse(value);
  if (!parsed.success) {
    throw new AttestCliError('cli_usage', 'Imported agent JSON does not match its schema.', {
      path: 'source',
      details: { diagnostics: requestDiagnostics(parsed.error.issues) },
    });
  }
  const resource = { ...parsed.data, id: agentId, name: name?.trim() || parsed.data.name };
  assertSafeNativeAgentResource(resource);
  return resource;
};

type CurlAgentImportRequest = Extract<
  CommandRequest,
  { command: 'agent.import'; source_type: 'curl' }
>;

/** Reads one bounded local/stdin cURL document without permitting remote source indirection. */
const readCurlDocument = async (
  source: string,
  workingDirectory: string,
  readStdin: ReadInput,
): Promise<string> => {
  let text: string;
  try {
    if (/^https?:\/\//u.test(source)) throw new Error('remote cURL sources are not supported');
    text =
      source === '-'
        ? await readStdin()
        : await readFile(resolve(workingDirectory, source), 'utf8');
  } catch (error: unknown) {
    throw new AttestCliError('cli_usage', 'Could not read the selected cURL source.', {
      path: 'source',
      hint: 'Pass a local cURL file or `-` for stdin.',
      cause: error,
    });
  }
  if (Buffer.byteLength(text) > MAX_CURL_BYTES) {
    throw new AttestCliError('cli_usage', 'The cURL source exceeds the size limit.', {
      path: 'source',
      details: { maximum_bytes: MAX_CURL_BYTES },
    });
  }
  return text;
};

/** Reads one project-contained cURL data file through a no-follow bounded descriptor. */
const readCurlBodyFile = async (
  path: string,
  projectRoot: string,
  maximumBytes: number,
): Promise<string> => {
  const candidate = resolve(projectRoot, path);
  if (path.length === 0 || isAbsolute(path) || !isProjectPath(projectRoot, candidate)) {
    throw new AttestCliError('cli_usage', 'The cURL body file must be inside the project.', {
      path: 'source',
      details: { diagnostic: 'file_body_outside_project' },
    });
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    const [resolvedPath, pathMetadata] = await Promise.all([realpath(candidate), lstat(candidate)]);
    if (
      !metadata.isFile() ||
      !isProjectPath(projectRoot, resolvedPath) ||
      pathMetadata.isSymbolicLink() ||
      pathMetadata.dev !== metadata.dev ||
      pathMetadata.ino !== metadata.ino
    ) {
      throw new Error('body file must retain one project-contained regular-file identity');
    }
    if (metadata.size > maximumBytes) throw new Error('body file exceeds the request cap');
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - bytes));
      const read = await handle.read(chunk, 0, chunk.length, bytes);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
      if (bytes > maximumBytes) throw new Error('body file exceeds the request cap');
      chunks.push(chunk.subarray(0, read.bytesRead));
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
  } catch (error: unknown) {
    throw new AttestCliError('cli_usage', 'Could not safely read the cURL body file.', {
      path: 'source',
      hint: 'Use one project-contained regular UTF-8 file within the request byte cap.',
      details: { diagnostic: 'unsafe_file_body' },
      cause: error,
    });
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

/** Converts one inert cURL request into a canonical direct or polling agent resource. */
const createImportedCurlAgentResource = async (
  request: CurlAgentImportRequest,
  source: string,
  projectRoot: string,
): Promise<{ agent: AgentResource; preview: CurlImportPreview }> => {
  let parsedCurl: ReturnType<typeof parseCurlCommand>;
  try {
    const bodyFilePath = findCurlBodyFilePath(source);
    const bodyFile =
      bodyFilePath === undefined
        ? undefined
        : {
            path: bodyFilePath,
            text: await readCurlBodyFile(
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
      throw new AttestCliError('cli_usage', error.message, {
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
  const parsed = agentResourceSchema.safeParse({
    schema: AGENT_RESOURCE_SCHEMA_ID,
    id: request.as,
    name: request.name?.trim() || request.as,
    transport,
    ...(request.timeouts === undefined ? {} : { timeouts: request.timeouts }),
    ...(request.retry === undefined ? {} : { retry: request.retry }),
    ...(request.limits === undefined ? {} : { limits: request.limits }),
    ...((request.header_env === undefined || Object.keys(request.header_env).length === 0) &&
    (request.query_env === undefined || Object.keys(request.query_env).length === 0)
      ? {}
      : {
          redaction: {
            ...(request.header_env === undefined
              ? {}
              : { headers: Object.keys(request.header_env) }),
            ...(request.query_env === undefined ? {} : { query: Object.keys(request.query_env) }),
          },
        }),
  });
  if (!parsed.success) {
    throw new AttestCliError('cli_usage', 'The cURL mapping does not match the agent schema.', {
      path: 'source',
      details: { diagnostics: requestDiagnostics(parsed.error.issues) },
    });
  }
  assertSafeNativeAgentResource(parsed.data);
  return { agent: parsed.data, preview: parsedCurl.preview };
};

export {
  createImportedCurlAgentResource,
  readCurlBodyFile,
  readCurlDocument,
  readImportedAgentResource,
};
