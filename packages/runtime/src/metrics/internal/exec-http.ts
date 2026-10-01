import type { MetricErrorInfo } from '../metric-evaluation.js';
import type { HttpMetricDefinition } from '../metric-definitions.js';
import { abortReasonOf, composeAbortSignal } from './abort-signal.js';
import {
  abortedMetricError,
  type MetricTransportOptions,
  type MetricTransportOutcome,
} from './metric-transport.js';

/** Reads at most the configured bytes; leaving the loop early cancels the network stream. */
const readCappedResponseBody = async (
  body: ReadableStream<Uint8Array>,
  outputCapBytes: number,
): Promise<MetricTransportOutcome> => {
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of body) {
    receivedBytes += chunk.byteLength;
    if (receivedBytes > outputCapBytes) {
      return {
        ok: false,
        error: {
          code: 'exec_malformed_output',
          message: `Metric HTTP response exceeded the ${outputCapBytes}-byte limit.`,
        },
      };
    }
    chunks.push(Buffer.from(chunk));
  }
  return { ok: true, text: Buffer.concat(chunks).toString() };
};

/** Rejects non-HTTP schemes at runtime even when a trusted schema admitted a future URL scheme. */
const parseHttpUrl = (
  value: string,
): { ok: true; url: URL } | { ok: false; error: MetricErrorInfo } => {
  if (!URL.canParse(value)) {
    return {
      ok: false,
      error: {
        code: 'http_request_failed',
        message: `Metric HTTP URL must be a valid http:// or https:// URL; received "${value}".`,
      },
    };
  }
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      error: {
        code: 'http_request_failed',
        message: `Metric HTTP URL must use http: or https:, not ${url.protocol}`,
      },
    };
  }
  return { ok: true, url };
};

/** Posts one metric envelope through the HTTP boundary with capped streaming and owned cancellation. */
const invokeHttpMetric = async (
  definition: HttpMetricDefinition,
  requestBody: string,
  options: MetricTransportOptions,
): Promise<MetricTransportOutcome> => {
  const parsed = parseHttpUrl(definition.url);
  if (!parsed.ok) {
    return parsed;
  }

  const signal = composeAbortSignal(options.signal, options.timeoutMs);
  try {
    const response = await fetch(parsed.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody,
      signal,
    });
    if (response.status !== 200) {
      // Cancellation is cleanup; the status error below stays authoritative even if it fails.
      await response.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        error: {
          code: 'http_bad_status',
          message: `Metric HTTP endpoint returned ${response.status}, expected 200.`,
          details: { status: response.status },
        },
      };
    }
    if (response.body === null) {
      return { ok: true, text: '' };
    }
    return await readCappedResponseBody(response.body, options.outputCapBytes);
  } catch (error: unknown) {
    if (signal.aborted) {
      return { ok: false, error: abortedMetricError(abortReasonOf(signal), options.timeoutMs) };
    }
    return {
      ok: false,
      error: {
        code: 'http_request_failed',
        message: `Could not call metric HTTP endpoint: ${error instanceof Error ? error.message : 'unknown error'}`,
      },
    };
  }
};

export { invokeHttpMetric };
