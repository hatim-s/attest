import { AGENT_PROTOCOL, AGENT_RESOURCE_SCHEMA_ID, type AgentRequest } from '@attest/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  createFetchHttpTransports,
  invokeMappedHttpAgent,
  invokeNativeHttpAgent,
  invokeStreamingAgent,
  type HttpAgentResource,
  type StreamAgentResource,
} from '../http.js';

const request: AgentRequest = {
  protocol: AGENT_PROTOCOL,
  run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  case_id: 'cloud',
  input: 'hello',
};
const mapped: HttpAgentResource = {
  schema: AGENT_RESOURCE_SCHEMA_ID,
  id: 'mapped',
  name: 'Mapped',
  transport: {
    kind: 'http',
    lifecycle: 'external',
    response_mode: 'mapped',
    request: { method: 'POST', url: 'https://agent.example/run', body: '{{request}}' },
    extraction: { result_pointer: '/answer' },
  },
  retry: { retries: 3, backoff: { kind: 'none' } },
  timeouts: { attempt_ms: 1000, idle_ms: 50 },
};
const streaming = (framing: 'sse' | 'jsonl'): StreamAgentResource => ({
  schema: AGENT_RESOURCE_SCHEMA_ID,
  id: 'stream',
  name: 'Stream',
  transport: {
    kind: 'stream',
    lifecycle: 'external',
    framing,
    request: { method: 'POST', url: 'https://agent.example/run', body: '{{request}}' },
    terminal_pointer: '/type',
    terminal_values: ['done'],
    result_pointer: '/output',
  },
  retry: { retries: 3, backoff: { kind: 'none' } },
  timeouts: { attempt_ms: 1000, idle_ms: 50 },
});

/** Creates a live response whose reader must be cancelled after a cap, terminal, or deadline. */
const liveResponse = (chunk: string, contentType: string) => {
  const cancelled = vi.fn();
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(chunk));
      },
      cancel: cancelled,
    }),
    { headers: { 'content-type': contentType } },
  );
  return { response, cancelled };
};

describe('host HTTP transports', () => {
  it('validates native envelopes and never retries a failed request', async () => {
    const httpFetch = vi.fn(() =>
      Promise.resolve(Response.json({ protocol: AGENT_PROTOCOL, output: 'ok' })),
    );
    const result = await invokeNativeHttpAgent(
      { type: 'http', url: 'https://agent.example/run' },
      request,
      { timeoutMs: 1000, outputCapBytes: 1024, httpFetch },
    );
    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && result.report?.ok).toBe(true);
    const failedFetch = vi.fn(() => Promise.resolve(new Response('unavailable', { status: 503 })));
    const failure = await invokeNativeHttpAgent(
      { type: 'http', url: 'https://agent.example/run' },
      request,
      { timeoutMs: 1000, outputCapBytes: 1024, httpFetch: failedFetch },
    );
    expect(failure.attempts).toHaveLength(1);
    expect(failedFetch).toHaveBeenCalledTimes(1);
  });

  it('uses shared mapped extraction and overrides an authored retry budget', async () => {
    const guardedFetch = vi.fn(() => Promise.resolve(Response.json({ answer: { value: 42 } })));
    const transports = createFetchHttpTransports(guardedFetch);
    const result = await invokeMappedHttpAgent(mapped, request, { ...transports, retries: 0 });
    expect(result.status === 'ok' && result.report?.ok && result.report.value).toMatchObject({
      output: { value: 42 },
    });
    guardedFetch.mockImplementation(() => Promise.resolve(new Response('failed', { status: 503 })));
    const failed = await invokeMappedHttpAgent(mapped, request, { ...transports, retries: 0 });
    expect(failed.attempts).toHaveLength(1);
    expect(guardedFetch).toHaveBeenCalledTimes(2);
  });

  it.each(['sse', 'jsonl'] as const)(
    'extracts %s terminal output and closes the reader',
    async (framing) => {
      const payload = JSON.stringify({ type: 'done', output: 'ok' });
      const live = liveResponse(
        framing === 'sse' ? `data: ${payload}\n\n` : `${payload}\n`,
        framing === 'sse' ? 'text/event-stream' : 'application/x-ndjson',
      );
      const transports = createFetchHttpTransports(() => Promise.resolve(live.response));
      const result = await invokeStreamingAgent(streaming(framing), request, {
        ...transports,
        retries: 0,
      });
      expect(result.status === 'ok' && result.report?.ok && result.report.value).toMatchObject({
        output: 'ok',
      });
      expect(live.cancelled).toHaveBeenCalledOnce();
    },
  );

  it('cancels a capped mapped body and an idle stream without replay', async () => {
    const capped = liveResponse('0123456789', 'application/json');
    const result = await invokeMappedHttpAgent(
      { ...mapped, limits: { response_bytes: 4 } },
      request,
      { ...createFetchHttpTransports(() => Promise.resolve(capped.response)), retries: 0 },
    );
    expect(result.status === 'invocation_error' && result.error.code).toBe('output_cap_exceeded');
    expect(capped.cancelled).toHaveBeenCalledOnce();
    const idle = liveResponse('{"type":"delta"}\n', 'application/x-ndjson');
    const idleFetch = vi.fn(() => Promise.resolve(idle.response));
    const timeout = await invokeStreamingAgent(streaming('jsonl'), request, {
      ...createFetchHttpTransports(idleFetch),
      retries: 0,
    });
    expect(timeout.status === 'invocation_error' && timeout.error.code).toBe('timeout');
    expect(idle.cancelled).toHaveBeenCalledOnce();
    expect(idleFetch).toHaveBeenCalledOnce();
  });

  it('rejects redirects to a different origin before a second guarded fetch', async () => {
    const guardedFetch = vi.fn(() =>
      Promise.resolve(
        new Response('', { status: 307, headers: { location: 'https://other.example/run' } }),
      ),
    );
    const result = await invokeMappedHttpAgent(mapped, request, {
      ...createFetchHttpTransports(guardedFetch),
      retries: 0,
    });
    expect(result.status === 'invocation_error' && result.error.code).toBe('http_status');
    expect(guardedFetch).toHaveBeenCalledOnce();
  });
  it('classifies cancellation before streaming headers without retrying', async () => {
    const controller = new AbortController();
    const guardedFetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Cancelled', 'AbortError')),
            { once: true },
          );
          controller.abort();
        }),
    );
    const result = await invokeStreamingAgent(streaming('jsonl'), request, {
      ...createFetchHttpTransports(guardedFetch),
      signal: controller.signal,
      retries: 0,
    });
    expect(result.status === 'invocation_error' && result.error.code).toBe('cancelled');
    expect(guardedFetch).toHaveBeenCalledOnce();
  });

  it('retains shared submit-and-poll semantics on the guarded transport', async () => {
    const guardedFetch = vi.fn((url: string) =>
      Promise.resolve(
        Response.json(url.endsWith('/run') ? { job: 'one' } : { state: 'done', answer: 'ok' }),
      ),
    );
    const polling: HttpAgentResource = {
      ...mapped,
      transport: {
        kind: 'polling',
        lifecycle: 'external',
        submit: { method: 'POST', url: 'https://agent.example/run', body: '{{request}}' },
        job_id_pointer: '/job',
        status_url_template: 'https://agent.example/jobs/{{job_id}}',
        status_pointer: '/state',
        success_values: ['done'],
        failure_values: ['failed'],
        minimum_interval_ms: 1,
        maximum_interval_ms: 2,
        extraction: { result_pointer: '/answer' },
      },
    };
    const result = await invokeMappedHttpAgent(polling, request, {
      ...createFetchHttpTransports(guardedFetch),
      retries: 0,
    });
    expect(result.status === 'ok' && result.report?.ok && result.report.value).toMatchObject({
      output: 'ok',
    });
    expect(result.diagnostics.remoteJobId).toBe('one');
    expect(guardedFetch).toHaveBeenCalledTimes(2);
  });
  it.each(['json', 'jsonl'] as const)(
    'uses first-byte rather than connect timeout for delayed %s headers',
    async (mode) => {
      const delayedFetch = (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const abort = (): void => {
            clearTimeout(timer);
            reject(init.signal?.reason);
          };
          const timer = setTimeout(() => {
            init.signal?.removeEventListener('abort', abort);
            resolve(
              mode === 'json'
                ? Response.json({ answer: 'ok' })
                : new Response('{"type":"done","output":"ok"}\n'),
            );
          }, 30);
          init.signal?.addEventListener('abort', abort, { once: true });
        });
      const invoke = (firstByteMs: number) => {
        const transports = createFetchHttpTransports(delayedFetch);
        const timeouts = {
          connect_ms: 1,
          first_byte_ms: firstByteMs,
          attempt_ms: 1000,
          idle_ms: 50,
        };
        return mode === 'json'
          ? invokeMappedHttpAgent({ ...mapped, timeouts }, request, { ...transports, retries: 0 })
          : invokeStreamingAgent({ ...streaming('jsonl'), timeouts }, request, {
              ...transports,
              retries: 0,
            });
      };
      const completed = await invoke(200);
      expect(completed.status).toBe('ok');
      const expired = await invoke(5);
      expect(expired.status === 'invocation_error' && expired.error.code).toBe('timeout');
      expect(expired.attempts).toHaveLength(1);
    },
  );
});
