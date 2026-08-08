import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { AgentInvocationError } from '../../errors.js';
import { createRawExcerpt } from '../../internal/raw-excerpt.js';
import type { InvocationAttempt } from '../../types.js';
import type { MaterializedHttpRequest } from './request-template.js';
import { requireSameOrigin, resolveSafeHttpUrl } from './url-security.js';

type HttpClientPolicy = {
  attemptSignal: AbortSignal;
  callerSignal?: AbortSignal;
  connectTimeoutMs: number;
  firstByteTimeoutMs: number;
  responseBodyTimeoutMs: number;
  responseCapBytes: number;
  secretsPresent: boolean;
};

type HttpJsonResponse = {
  headers: Record<string, string>;
  raw: unknown;
  rawExcerpt: NonNullable<InvocationAttempt['rawExcerpt']>;
  status: number;
  url: URL;
};

const MAX_REDIRECTS = 3;
const EVIDENCE_PREFIX_BYTES = 16 * 1024;

const abortError = (policy: HttpClientPolicy, cause?: unknown): AgentInvocationError =>
  new AgentInvocationError(
    policy.callerSignal?.aborted === true ? 'cancelled' : 'timeout',
    policy.callerSignal?.aborted === true
      ? 'Mapped HTTP invocation was cancelled.'
      : 'Mapped HTTP request timed out.',
    { cause },
  );

const normalizeHeaders = (headers: NodeJS.Dict<string | string[]>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers)
      .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
      .map(([name, value]) => [
        name.toLowerCase(),
        Array.isArray(value) ? value.join(', ') : value,
      ]),
  );

/** Reads and hashes a JSON body while enforcing both idle and aggregate byte caps. */
const readJsonBody = async (
  response: import('node:http').IncomingMessage,
  policy: HttpClientPolicy,
): Promise<{ raw: unknown; rawExcerpt: NonNullable<InvocationAttempt['rawExcerpt']> }> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const evidence: Buffer[] = [];
    const digest = createHash('sha256');
    let byteCount = 0;
    let evidenceBytes = 0;
    let settled = false;
    let idleTimer: NodeJS.Timeout;

    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      policy.attemptSignal.removeEventListener('abort', abort);
      operation();
    };
    const resetIdle = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () =>
          finish(() =>
            reject(new AgentInvocationError('timeout', 'Mapped HTTP response body timed out.')),
          ),
        policy.responseBodyTimeoutMs,
      );
    };
    const abort = (): void => {
      response.destroy();
      finish(() => reject(abortError(policy)));
    };

    policy.attemptSignal.addEventListener('abort', abort, { once: true });
    response.on('data', (chunk: Buffer) => {
      resetIdle();
      byteCount += chunk.byteLength;
      digest.update(chunk);
      if (evidenceBytes < EVIDENCE_PREFIX_BYTES) {
        const retained = chunk.subarray(0, EVIDENCE_PREFIX_BYTES - evidenceBytes);
        evidence.push(retained);
        evidenceBytes += retained.byteLength;
      }
      if (byteCount > policy.responseCapBytes) {
        response.destroy();
        const prefix = Buffer.concat(evidence, evidenceBytes).toString('utf8');
        finish(() =>
          reject(
            Object.assign(
              new AgentInvocationError(
                'output_cap_exceeded',
                `Mapped HTTP response exceeds the ${policy.responseCapBytes}-byte response cap.`,
              ),
              {
                rawExcerpt: {
                  ...createRawExcerpt(prefix),
                  truncated: true,
                  sha256: digest.digest('hex'),
                },
              },
            ),
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    response.once('error', (error) => finish(() => reject(error)));
    response.once('end', () => {
      const text = Buffer.concat(chunks, byteCount).toString('utf8');
      const rawExcerpt = createRawExcerpt(text);
      try {
        const raw = JSON.parse(text) as unknown;
        finish(() => resolve({ raw, rawExcerpt }));
      } catch (error: unknown) {
        finish(() =>
          reject(
            Object.assign(
              new AgentInvocationError(
                'invalid_envelope',
                'Mapped HTTP response is not valid JSON.',
                {
                  cause: error,
                },
              ),
              { rawExcerpt },
            ),
          ),
        );
      }
    });
    resetIdle();
  });

/** Performs one DNS-pinned request and returns only bounded JSON evidence. */
const requestOnce = async (
  request: MaterializedHttpRequest,
  policy: HttpClientPolicy,
): Promise<HttpJsonResponse> => {
  const resolved = await resolveSafeHttpUrl(
    request.url,
    policy.connectTimeoutMs,
    policy.attemptSignal,
    policy.callerSignal,
  );
  if (policy.secretsPresent && resolved.url.protocol !== 'https:' && !resolved.loopback) {
    throw new AgentInvocationError(
      'network',
      'Mapped HTTP secrets require HTTPS except for explicit loopback endpoints.',
    );
  }
  const transport = resolved.url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<HttpJsonResponse>((resolve, reject) => {
    let settled = false;
    const timers: { firstByte?: NodeJS.Timeout } = {};
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      if (timers.firstByte !== undefined) clearTimeout(timers.firstByte);
      policy.attemptSignal.removeEventListener('abort', abort);
      operation();
    };
    const outgoing = transport(
      resolved.url,
      {
        method: request.method,
        headers: request.headers,
        lookup: (_hostname, _options, callback) =>
          callback(null, resolved.address, resolved.family),
      },
      (response) => {
        // The response body owns its own idle deadline after headers arrive.
        outgoing.setTimeout(0);
        if (timers.firstByte !== undefined) clearTimeout(timers.firstByte);
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          response.resume();
          finish(() =>
            resolve({
              headers: normalizeHeaders(response.headers),
              raw: null,
              rawExcerpt: createRawExcerpt(''),
              status,
              url: resolved.url,
            }),
          );
          return;
        }
        void readJsonBody(response, policy).then(
          ({ raw, rawExcerpt }) =>
            finish(() =>
              resolve({
                headers: normalizeHeaders(response.headers),
                raw,
                rawExcerpt,
                status,
                url: resolved.url,
              }),
            ),
          (error: unknown) =>
            finish(() =>
              reject(error instanceof Error ? error : new Error('HTTP body read failed.')),
            ),
        );
      },
    );
    const abort = (): void => {
      outgoing.destroy();
      finish(() => reject(abortError(policy)));
    };
    policy.attemptSignal.addEventListener('abort', abort, { once: true });
    timers.firstByte = setTimeout(() => {
      outgoing.destroy();
      finish(() =>
        reject(new AgentInvocationError('timeout', 'Mapped HTTP first byte timed out.')),
      );
    }, policy.firstByteTimeoutMs);
    outgoing.setTimeout(policy.connectTimeoutMs, () => {
      outgoing.destroy();
      finish(() =>
        reject(new AgentInvocationError('timeout', 'Mapped HTTP connection timed out.')),
      );
    });
    outgoing.once('error', (error) => {
      finish(() =>
        reject(
          error instanceof AgentInvocationError
            ? error
            : new AgentInvocationError('network', 'Mapped HTTP transport failed.', {
                cause: error,
              }),
        ),
      );
    });
    if (request.body !== undefined) outgoing.write(request.body);
    outgoing.end();
  });
};

/** Follows only bounded, method-preserving, same-origin redirects. */
const requestJson = async (
  request: MaterializedHttpRequest,
  policy: HttpClientPolicy,
): Promise<HttpJsonResponse> => {
  const origin = new URL(request.url);
  let current = request;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await requestOnce(current, policy);
    if (![307, 308].includes(response.status)) return response;
    const location = response.headers.location;
    if (location === undefined || redirects === MAX_REDIRECTS) {
      throw Object.assign(
        new AgentInvocationError('http_status', `Mapped HTTP returned status ${response.status}.`),
        { httpStatus: response.status, rawExcerpt: response.rawExcerpt },
      );
    }
    const redirected = new URL(location, response.url);
    requireSameOrigin(redirected, origin);
    current = { ...current, url: redirected.toString() };
  }
  throw new AgentInvocationError('http_status', 'Mapped HTTP redirect limit was exceeded.');
};

export { requestJson, type HttpClientPolicy, type HttpJsonResponse };
