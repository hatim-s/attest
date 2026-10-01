import type { MetricDefinition } from '@attest/contracts';

import type { MetricErrorInfo } from '../metric-evaluation.js';
import { createAbortContext } from './abort-context.js';

/** Narrows executable metric definitions to the HTTP transport. */
type HttpMetricDefinition = Extract<MetricDefinition, { type: 'exec' }> & { url: string };

/** Describes the limits and cancellation channel owned by one HTTP invocation. */
type InvokeHttpMetricOptions = {
  outputCapBytes: number;
  signal?: AbortSignal;
  timeoutMs: number;
};

/** Keeps transport errors separate from successful response text. */
type HttpInvocationOutcome = { ok: true; text: string } | { ok: false; error: MetricErrorInfo };

/** Cancels a response body and tolerates an already-closed or transport-failed stream. */
const cancelResponseBody = async (body: ReadableStream<Uint8Array> | null): Promise<void> => {
  if (body === null) {
    return;
  }
  try {
    await body.cancel();
  } catch {
    // Cancellation is cleanup; the transport error returned to the caller remains authoritative.
  }
};

/** Cancels through the active reader and then the released body so both fetch layers observe cleanup. */
const cancelResponseReader = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  body: ReadableStream<Uint8Array>,
): Promise<void> => {
  try {
    await reader.cancel();
  } catch {
    // Continue to body cancellation even if the reader reports an already-failed transport.
  }
  reader.releaseLock();
  await cancelResponseBody(body);
};

/** Reads at most the configured bytes and cancels the network stream before reporting overflow. */
const readCappedResponseBody = async (
  response: Response,
  outputCapBytes: number,
): Promise<HttpInvocationOutcome> => {
  const body = response.body;
  if (body === null) {
    return { ok: true, text: '' };
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        return { ok: true, text: Buffer.concat(chunks).toString() };
      }

      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > outputCapBytes) {
        await cancelResponseReader(reader, body);
        return {
          ok: false,
          error: {
            code: 'exec_malformed_output',
            message: `Metric HTTP response exceeded the ${outputCapBytes}-byte limit.`,
          },
        };
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    // The overflow path releases before cancelling the body; normal reads release here.
    try {
      reader.releaseLock();
    } catch {
      // A lock can only already be released by the explicit overflow cleanup above.
    }
  }
};

/** Validates the runtime URL boundary even when a trusted schema admitted a future URL scheme. */
const validateHttpUrl = (value: string): MetricErrorInfo | URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return {
      code: 'http_request_failed',
      message: `Metric HTTP URL must be a valid http:// or https:// URL; received "${value}".`,
    };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      code: 'http_request_failed',
      message: `Metric HTTP URL must use http: or https:, not ${url.protocol}`,
    };
  }
  return url;
};

/** Posts one metric envelope through the HTTP boundary with capped streaming and owned cancellation. */
const invokeHttpMetric = async (
  definition: HttpMetricDefinition,
  requestBody: string,
  options: InvokeHttpMetricOptions,
): Promise<HttpInvocationOutcome> => {
  const url = validateHttpUrl(definition.url);
  if ('code' in url) {
    return { ok: false, error: url };
  }

  const abortContext = createAbortContext({
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    timeoutMessage: `Metric execution exceeded ${options.timeoutMs} ms.`,
  });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody,
      signal: abortContext.controller.signal,
    });
    if (response.status !== 200) {
      await cancelResponseBody(response.body);
      return {
        ok: false,
        error: {
          code: 'http_bad_status',
          message: `Metric HTTP endpoint returned ${response.status}, expected 200.`,
          details: { status: response.status },
        },
      };
    }

    return readCappedResponseBody(response, options.outputCapBytes);
  } catch (error: unknown) {
    const abortReason = abortContext.reason();
    if (abortReason !== undefined) {
      return {
        ok: false,
        error:
          abortReason === 'cancelled'
            ? { code: 'metric_cancelled', message: 'Metric execution was cancelled.' }
            : {
                code: 'exec_timeout',
                message: `Metric execution exceeded ${options.timeoutMs} ms.`,
              },
      };
    }
    return {
      ok: false,
      error: {
        code: 'http_request_failed',
        message: `Could not call metric HTTP endpoint: ${error instanceof Error ? error.message : 'unknown error'}`,
      },
    };
  } finally {
    abortContext.dispose();
  }
};

export {
  invokeHttpMetric,
  readCappedResponseBody,
  validateHttpUrl,
  type HttpInvocationOutcome,
  type HttpMetricDefinition,
  type InvokeHttpMetricOptions,
};
