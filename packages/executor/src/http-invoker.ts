import type { AgentRequest, RawExcerpt } from '@attest/contracts';
import { createHash } from 'node:crypto';

import { AgentInvocationError } from './errors.js';
import { startTimer } from './internal/elapsed.js';
import { createFailedAttempt } from './internal/failed-attempt.js';
import { appendEvidencePrefix, createRawExcerpt } from './internal/raw-excerpt.js';
import type { InvocationAttempt, InvokeOptions, NativeAgentTarget } from './types.js';

const HTTP_SUCCESS_STATUS = 200;

/** Cancels an abandoned body; a failed cancellation cannot change the failure already classified. */
const swallowCancel = async (cancellation: Promise<void> | undefined): Promise<void> => {
  try {
    await cancellation;
  } catch {
    // The transport outcome is already decided.
  }
};

type CappedJson =
  | { ok: true; raw: unknown; rawExcerpt: RawExcerpt }
  | { ok: false; error: AgentInvocationError; rawExcerpt?: RawExcerpt };

/** Creates cap evidence that is always marked truncated and hashes every byte received so far. */
const createCappedRawExcerpt = (
  evidenceChunks: readonly Uint8Array[],
  evidenceByteCount: number,
  digest: string,
): RawExcerpt => ({
  ...createRawExcerpt(Buffer.concat(evidenceChunks, evidenceByteCount).toString('utf8')),
  truncated: true,
  sha256: digest,
});

const readCappedJson = async (response: Response, outputCapBytes: number): Promise<CappedJson> => {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return {
      ok: false,
      error: new AgentInvocationError(
        'invalid_envelope',
        'HTTP agent response body is not valid JSON.',
      ),
    };
  }

  const chunks: Uint8Array[] = [];
  const evidenceChunks: Uint8Array[] = [];
  const payloadHash = createHash('sha256');
  let byteCount = 0;
  let evidenceByteCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      byteCount += value.byteLength;
      payloadHash.update(value);
      evidenceByteCount = appendEvidencePrefix(evidenceChunks, evidenceByteCount, value);
      if (byteCount > outputCapBytes) {
        // Cancel immediately so an unbounded response is not fully downloaded before rejection.
        await swallowCancel(reader.cancel());
        return {
          ok: false,
          error: new AgentInvocationError(
            'output_cap_exceeded',
            `HTTP agent response exceeds the ${outputCapBytes}-byte output cap.`,
          ),
          rawExcerpt: createCappedRawExcerpt(
            evidenceChunks,
            evidenceByteCount,
            payloadHash.digest('hex'),
          ),
        };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const payload = Buffer.concat(chunks).toString('utf8');
  const rawExcerpt = createRawExcerpt(payload);

  try {
    return { ok: true, raw: JSON.parse(payload) as unknown, rawExcerpt };
  } catch (error) {
    return {
      ok: false,
      error: new AgentInvocationError(
        'invalid_envelope',
        'HTTP agent response body is not valid JSON.',
        { cause: error },
      ),
      rawExcerpt,
    };
  }
};

const isTimeoutFailure = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'TimeoutError';

const fetchFailureMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'unknown transport failure';

const classifyFetchFailure = (error: unknown, options: InvokeOptions): AgentInvocationError => {
  if (error instanceof AgentInvocationError) {
    return error;
  }

  if (options.signal?.aborted) {
    return new AgentInvocationError('cancelled', 'HTTP agent invocation was cancelled.', {
      cause: error,
    });
  }

  if (isTimeoutFailure(error)) {
    return new AgentInvocationError('timeout', 'HTTP agent invocation timed out.', {
      cause: error,
    });
  }

  // Fetch wraps DNS, connection, and reset failures differently across Node and Bun.
  return new AgentInvocationError(
    'network',
    `HTTP agent request failed: ${fetchFailureMessage(error)}.`,
    {
      cause: error,
    },
  );
};

/**
 * Invokes an HTTP agent once so the runner can apply the contract's retry policy separately.
 *
 * The HTTP transport and execution-semantics sections of docs/specs/agent-contract.md require
 * infrastructure failures to remain distinct from agent response-envelope semantics downstream.
 * Redirects are deliberately not followed: every 3xx is a terminal `http_status` error and is
 * never retried, preventing request envelopes from being forwarded to an unconfigured endpoint.
 */
const invokeHttpAgent = async (
  target: Extract<NativeAgentTarget, { type: 'http' }>,
  request: AgentRequest,
  options: InvokeOptions,
): Promise<InvocationAttempt> => {
  const duration = startTimer();
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
  // One combined signal lets either the caller or deadline stop the underlying request.
  const signal =
    options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);
  let httpStatus: number | undefined;

  try {
    const response = await (options.httpFetch ?? fetch)(target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...options.httpHeaders },
      body: JSON.stringify(request),
      redirect: 'manual',
      signal,
    });
    httpStatus = response.status;

    if (response.status !== HTTP_SUCCESS_STATUS) {
      // Status is authoritative at header receipt; body size and read failures cannot reclassify it.
      void swallowCancel(response.body?.cancel());
      return createFailedAttempt(
        new AgentInvocationError('http_status', `HTTP agent returned status ${response.status}.`),
        { diagnostics: { httpStatus: response.status }, durationMs: duration() },
      );
    }

    const parsed = await readCappedJson(response, options.outputCapBytes);
    if (!parsed.ok) {
      return createFailedAttempt(parsed.error, {
        diagnostics: { httpStatus: response.status },
        durationMs: duration(),
        rawExcerpt: parsed.rawExcerpt,
      });
    }

    return {
      status: 'ok',
      raw: parsed.raw,
      diagnostics: { httpStatus: response.status },
      durationMs: duration(),
      rawExcerpt: parsed.rawExcerpt,
      warnings: [],
    };
  } catch (error) {
    return createFailedAttempt(classifyFetchFailure(error, options), {
      diagnostics: httpStatus === undefined ? {} : { httpStatus },
      durationMs: duration(),
    });
  }
};

export { invokeHttpAgent };
