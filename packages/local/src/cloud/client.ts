import type { JsonValue } from '@attest/contracts';
import { redactTransportText } from '@attest/executor';
import { z } from 'zod';

import type { CloudCredentialSource } from './credentials.js';

import { LocalError } from '../errors/local-error.js';
import { CloudRemoteError, decodeRemoteError, parseCloudEndpoint } from './protocol.js';

type CloudClient = {
  readonly baseUrl: string;
  readonly credentialSource?: CloudCredentialSource;
  upload: <T>(
    path: string,
    options: { schema: z.ZodType<T>; body: string; signal?: AbortSignal },
  ) => Promise<T>;
  request: <T>(
    method: string,
    path: string,
    options: { schema: z.ZodType<T>; body?: JsonValue; signal?: AbortSignal },
  ) => Promise<T>;
};

type CloudClientOptions = {
  baseUrl: string;
  accessToken?: string;
  credentialSource?: CloudCredentialSource;
  fetch?: typeof fetch;
};

/** Accepts encrypted endpoints and local development servers without embedded credentials. */
const normalizeCloudUrl = (value: string): string => {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new LocalError('cli_usage', 'Cloud URL must be an absolute HTTPS URL.');
  }

  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new LocalError(
      'cli_usage',
      'Cloud URL must be an HTTPS origin, or an HTTP loopback origin.',
    );
  }

  return url.origin;
};

/** Bounds response bytes before decoding UTF-8, including proxy error bodies. */
const readResponseText = async (response: Response): Promise<string> => {
  const limit = 16 * 1024 * 1024;

  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new LocalError('cloud_request_failed', 'Cloud response exceeds the supported size.');
  }

  const reader = response.body?.getReader();

  if (!reader) throw new LocalError('cloud_request_failed', 'Cloud response is empty.');
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const chunk = await reader.read();

      if (chunk.done) break;
      size += chunk.value.byteLength;

      if (size > limit) {
        await reader.cancel();
        throw new LocalError('cloud_request_failed', 'Cloud response exceeds the supported size.');
      }

      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(bytes);
};

/** Sends authenticated requests only to the configured origin; redirects never receive credentials. */
const createCloudClient = (options: CloudClientOptions): CloudClient => {
  const baseUrl = normalizeCloudUrl(options.baseUrl);
  const fetcher = options.fetch ?? fetch;

  const send = async <T>(
    method: string,
    path: string,
    requestOptions: {
      schema: z.ZodType<T>;
      body?: string;
      signal?: AbortSignal;
      contentType: string;
      timeout: number;
    },
  ): Promise<T> => {
    const { body, signal } = requestOptions;

    if (
      !path.startsWith('/v1/') ||
      path.startsWith('//') ||
      new URL(path, baseUrl).origin !== baseUrl ||
      !new URL(path, baseUrl).pathname.startsWith('/v1/')
    ) {
      throw new LocalError('cli_usage', 'Cloud request path must stay under /v1/.');
    }

    let response: Response;

    try {
      const headers = new Headers({ accept: 'application/json' });

      if (body !== undefined) headers.set('content-type', requestOptions.contentType);

      if (options.accessToken !== undefined)
        headers.set('authorization', `Bearer ${options.accessToken}`);
      response = await fetcher(new URL(path, baseUrl), {
        method,
        redirect: 'error',
        signal:
          signal === undefined
            ? AbortSignal.timeout(requestOptions.timeout)
            : AbortSignal.any([signal, AbortSignal.timeout(requestOptions.timeout)]),
        headers,
        body,
      });
    } catch {
      throw new LocalError(
        signal?.aborted ? 'cancelled' : 'cloud_unavailable',
        'Cloud request did not complete.',
      );
    }

    if (!response.ok) {
      let value: unknown;

      try {
        value = JSON.parse(await readResponseText(response));
      } catch {
        /* An upstream proxy may return a non-JSON failure. */
      }

      const outcome = decodeRemoteError(value);

      if (outcome.kind === 'known') {
        outcome.message = redactTransportText(
          outcome.message,
          options.accessToken === undefined ? [] : [options.accessToken],
        );
      }

      throw new CloudRemoteError(response.status, outcome);
    }

    if (response.status === 204) return parseCloudEndpoint(requestOptions.schema, undefined);

    let value: unknown;

    try {
      value = JSON.parse(await readResponseText(response));
    } catch {
      throw new LocalError('cloud_request_failed', 'Cloud returned an invalid JSON response.');
    }

    return parseCloudEndpoint(requestOptions.schema, value);
  };

  return {
    baseUrl,
    credentialSource: options.credentialSource,
    request: (method, path, requestOptions) =>
      send(method, path, {
        ...requestOptions,
        contentType: 'application/json',
        timeout: 30_000,
        body: requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body),
      }),
    upload: (path, requestOptions) =>
      send('POST', path, {
        ...requestOptions,
        contentType: 'application/x-ndjson',
        timeout: 120_000,
      }),
  };
};

export { createCloudClient, normalizeCloudUrl, type CloudClient, type CloudClientOptions };
