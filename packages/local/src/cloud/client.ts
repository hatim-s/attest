import type { JsonValue } from '@attest/contracts';
import { z } from 'zod';
import { LocalError } from '../errors/local-error.js';

type CloudClient = {
  readonly baseUrl: string;
  request: (
    method: string,
    path: string,
    body?: JsonValue,
    signal?: AbortSignal,
  ) => Promise<JsonValue | undefined>;
};

type CloudClientOptions = { baseUrl: string; accessToken?: string; fetch?: typeof fetch };

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

/** Bounds response bytes before decoding JSON, including proxy error bodies. */
const readResponseJson = async (response: Response): Promise<JsonValue> => {
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

  return z.json().parse(JSON.parse(new TextDecoder().decode(bytes)));
};

/** Sends authenticated requests only to the configured origin; redirects never receive credentials. */
const createCloudClient = (options: CloudClientOptions): CloudClient => {
  const baseUrl = normalizeCloudUrl(options.baseUrl);
  const fetcher = options.fetch ?? fetch;

  return {
    baseUrl,
    async request(
      method: string,
      path: string,
      body?: JsonValue,
      signal?: AbortSignal,
    ): Promise<JsonValue | undefined> {
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

        if (body !== undefined) headers.set('content-type', 'application/json');

        if (options.accessToken !== undefined)
          headers.set('authorization', `Bearer ${options.accessToken}`);
        response = await fetcher(new URL(path, baseUrl), {
          method,
          redirect: 'error',
          signal:
            signal === undefined
              ? AbortSignal.timeout(30_000)
              : AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch {
        throw new LocalError(
          signal?.aborted ? 'cancelled' : 'cloud_unavailable',
          'Cloud request did not complete.',
        );
      }

      if (!response.ok) {
        let code = 'request_failed';

        try {
          const parsed = z
            .object({ error: z.object({ code: z.string().regex(/^[a-z_]{1,80}$/) }).optional() })
            .safeParse(await readResponseJson(response));

          if (parsed.success && parsed.data.error !== undefined) code = parsed.data.error.code;
        } catch {
          /* An upstream proxy may return a non-JSON failure. */
        }

        throw new LocalError(
          response.status === 401 ? 'cloud_auth_required' : 'cloud_request_failed',
          `Cloud request failed (${response.status}, ${code}).`,
          { details: { status: response.status, remote_code: code } },
        );
      }

      if (response.status === 204) return undefined;

      try {
        return await readResponseJson(response);
      } catch {
        throw new LocalError('cloud_request_failed', 'Cloud returned an invalid JSON response.');
      }
    },
  };
};

export { createCloudClient, normalizeCloudUrl, type CloudClient, type CloudClientOptions };
