import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  COMMAND_REQUEST_SCHEMA_ID,
  commandRequestSchema,
  type CommandRequest,
} from '@attest/contracts';

import { AttestCliError } from '../../../errors/index.js';
import type { JsonValue } from '../../../project/canonical-project.js';
import type { ReadInput } from './types.js';

const requestDiagnostics = (
  issues: readonly { message: string; path: PropertyKey[] }[],
): JsonValue => issues.map(({ message, path }) => ({ message, path: `/${path.join('/')}` }));

const MAX_REMOTE_JSON_BYTES = 1024 * 1024;
const REMOTE_JSON_TIMEOUT_MS = 10_000;

/** Fetches one bounded JSON document without following redirects or reflecting its URL. */
const readRemoteJson = async (source: string, path: string): Promise<string> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REMOTE_JSON_TIMEOUT_MS);
  try {
    const response = await fetch(source, { redirect: 'manual', signal: controller.signal });
    if (!response.ok) {
      throw new AttestCliError('cli_usage', 'The remote JSON source returned an error.', {
        path,
        details: { http_status: response.status },
      });
    }
    if (response.body === null) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_REMOTE_JSON_BYTES) {
        await reader.cancel();
        throw new AttestCliError('cli_usage', 'The remote JSON source exceeds the size limit.', {
          path,
          details: { maximum_bytes: MAX_REMOTE_JSON_BYTES },
        });
      }
      chunks.push(chunk.value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch (error: unknown) {
    if (error instanceof AttestCliError) throw error;
    throw new AttestCliError('cli_usage', 'Could not fetch the remote JSON source.', {
      path,
      hint: 'Use a reachable HTTP(S) JSON resource under 1 MiB.',
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }
};

/** Reads one JSON document while ensuring parse failures never echo sensitive source text. */
const readJsonDocument = async (
  source: string,
  workingDirectory: string,
  readStdin: ReadInput,
  path: string,
  allowRemote = false,
): Promise<unknown> => {
  let text: string;
  try {
    text = /^https?:\/\//u.test(source)
      ? allowRemote
        ? await readRemoteJson(source, path)
        : await Promise.reject(new Error('remote source is not allowed here'))
      : source === '-'
        ? await readStdin()
        : await readFile(resolve(workingDirectory, source), 'utf8');
  } catch (error: unknown) {
    if (error instanceof AttestCliError) throw error;
    throw new AttestCliError('cli_usage', 'Could not read the selected JSON source.', {
      path,
      hint: allowRemote
        ? 'Pass a readable JSON file, HTTP(S) URL, or `-` for stdin.'
        : 'Pass a readable JSON file or `-` for stdin.',
      cause: error,
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new AttestCliError('cli_usage', 'The selected input is not valid JSON.', {
      path,
      hint: 'Provide exactly one valid JSON document.',
      cause: error,
    });
  }
};

/** Loads and validates one command request from a file or stdin. */
const readAgentCommandRequest = async <CommandName extends CommandRequest['command']>(
  source: string,
  command: CommandName,
  workingDirectory: string,
  readStdin: ReadInput,
): Promise<Extract<CommandRequest, { command: CommandName }>> => {
  const value = await readJsonDocument(source, workingDirectory, readStdin, '--from-json');
  const parsed = commandRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new AttestCliError('cli_usage', 'The command request does not match its schema.', {
      path: '--from-json',
      hint: `Provide one ${COMMAND_REQUEST_SCHEMA_ID} ${command} document.`,
      details: { diagnostics: requestDiagnostics(parsed.error.issues) },
    });
  }
  if (parsed.data.command !== command) {
    throw new AttestCliError('cli_usage', 'The command request targets another command.', {
      path: '/command',
      hint: `Set \`command\` to \`${command}\`.`,
    });
  }
  return parsed.data as Extract<CommandRequest, { command: CommandName }>;
};

export { readAgentCommandRequest, readJsonDocument, requestDiagnostics };
