import * as Effect from 'effect/Effect';
import * as Cause from 'effect/Cause';
// EFFECT-ROOT: owned HTTP fixture execution.
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

    const result = await Effect.runPromise(
      invokeNativeHttpAgent({ type: 'http', url: 'https://agent.example/run' }, request, {
        timeoutMs: 1000,
        outputCapBytes: 1024,
        httpFetch,
      }),
    );

    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && result.report?.ok).toBe(true);
    const failedFetch = vi.fn(() => Promise.resolve(new Response('unavailable', { status: 503 })));

    const failure = await Effect.runPromise(
      invokeNativeHttpAgent({ type: 'http', url: 'https://agent.example/run' }, request, {
        timeoutMs: 1000,
        outputCapBytes: 1024,
        httpFetch: failedFetch,
      }),
    );

    expect(failure.attempts).toHaveLength(1);
    expect(failedFetch).toHaveBeenCalledTimes(1);
  });

  it('uses shared mapped extraction and overrides an authored retry budget', async () => {
    const guardedFetch = vi.fn(() => Promise.resolve(Response.json({ answer: { value: 42 } })));
    const transports = createFetchHttpTransports(guardedFetch);

    const result = await Effect.runPromise(
      invokeMappedHttpAgent(mapped, request, { ...transports, retries: 0 }),
    );

    expect(result.status === 'ok' && result.report?.ok && result.report.value).toMatchObject({
      output: { value: 42 },
    });
    guardedFetch.mockImplementation(() => Promise.resolve(new Response('failed', { status: 503 })));

    const failed = await Effect.runPromise(
      invokeMappedHttpAgent(mapped, request, { ...transports, retries: 0 }),
    );

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

      const result = await Effect.runPromise(
        invokeStreamingAgent(streaming(framing), request, {
          ...transports,
          retries: 0,
        }),
      );

      expect(result.status === 'ok' && result.report?.ok && result.report.value).toMatchObject({
        output: 'ok',
      });
      expect(live.cancelled).toHaveBeenCalledOnce();
    },
  );

  it('cancels a capped mapped body and an idle stream without replay', async () => {
    const capped = liveResponse('0123456789', 'application/json');

    const result = await Effect.runPromise(
      invokeMappedHttpAgent({ ...mapped, limits: { response_bytes: 4 } }, request, {
        ...createFetchHttpTransports(() => Promise.resolve(capped.response)),
        retries: 0,
      }),
    );

    expect(result.status === 'invocation_error' && result.error.code).toBe('output_cap_exceeded');
    expect(capped.cancelled).toHaveBeenCalledOnce();
    const idle = liveResponse('{"type":"delta"}\n', 'application/x-ndjson');
    const idleFetch = vi.fn(() => Promise.resolve(idle.response));

    const timeout = await Effect.runPromise(
      invokeStreamingAgent(streaming('jsonl'), request, {
        ...createFetchHttpTransports(idleFetch),
        retries: 0,
      }),
    );

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

    const result = await Effect.runPromise(
      invokeMappedHttpAgent(mapped, request, {
        ...createFetchHttpTransports(guardedFetch),
        retries: 0,
      }),
    );

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

    const result = await Effect.runPromise(
      invokeStreamingAgent(streaming('jsonl'), request, {
        ...createFetchHttpTransports(guardedFetch),
        signal: controller.signal,
        retries: 0,
      }),
    );

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

    const result = await Effect.runPromise(
      invokeMappedHttpAgent(polling, request, {
        ...createFetchHttpTransports(guardedFetch),
        retries: 0,
      }),
    );

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
            reject(new DOMException('Aborted', 'AbortError'));
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
          ? Effect.runPromise(
              invokeMappedHttpAgent({ ...mapped, timeouts }, request, {
                ...transports,
                retries: 0,
              }),
            )
          : Effect.runPromise(
              invokeStreamingAgent({ ...streaming('jsonl'), timeouts }, request, {
                ...transports,
                retries: 0,
              }),
            );
      };

      const completed = await invoke(200);
      expect(completed.status).toBe('ok');
      const expired = await invoke(5);
      expect(expired.status === 'invocation_error' && expired.error.code).toBe('timeout');
      expect(expired.attempts).toHaveLength(1);
    },
  );
  it.each(['idle', 'caller'] as const)(
    'does not accept buffered terminal JSONL after %s interruption',
    async (reason) => {
      const live = liveResponse('{"type":"done","output":"ok"}', 'application/x-ndjson');
      const controller = new AbortController();

      const configured = {
        ...streaming('jsonl'),
        timeouts: { attempt_ms: 1000, idle_ms: reason === 'idle' ? 20 : 500 },
      };

      const timer = reason === 'caller' ? setTimeout(() => controller.abort(), 10) : undefined;

      try {
        const result = await Effect.runPromise(
          invokeStreamingAgent(configured, request, {
            ...createFetchHttpTransports(() => Promise.resolve(live.response)),
            retries: 0,
            signal: controller.signal,
          }),
        );

        expect(result.status === 'invocation_error' && result.error.code).toBe(
          reason === 'idle' ? 'timeout' : 'cancelled',
        );
        expect(result.attempts).toHaveLength(1);
        expect(live.cancelled).toHaveBeenCalledOnce();
      } finally {
        clearTimeout(timer);
      }
    },
  );
});

it.each(['headers', 'body', 'cleanup'] as const)(
  'does not replay uncertain guarded %s failure through mapped transport',
  async (stage) => {
    const failure = new Error('foreign failure');

    const guarded = vi.fn(() =>
      stage === 'headers'
        ? Promise.reject(failure)
        : Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  if (stage === 'body') controller.error(failure);
                  else controller.enqueue(new TextEncoder().encode('{"answer":42}'));
                },
                pull(controller) {
                  if (stage === 'cleanup') controller.close();
                },
              }),
            ),
          ),
    );

    // A never-ending body observes its idle deadline and a rejected cancel separately.
    if (stage === 'cleanup')
      guarded.mockImplementation(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"answer":42}'));
              },
              cancel() {
                return Promise.reject(failure);
              },
            }),
          ),
        ),
      );

    const result = await Effect.runPromise(
      invokeMappedHttpAgent(mapped, request, createFetchHttpTransports(guarded)),
    );

    expect(result).toMatchObject({
      status: 'invocation_error',
      error: { applicationStarted: true },
    });
    expect(result.attempts).toHaveLength(1);
    expect(guarded).toHaveBeenCalledOnce();
  },
);

it.each(['ECONNREFUSED', 'ConnectionRefused', 'FailedToOpenSocket'])(
  'retains retries for known pre-dispatch %s on the error or its cause',
  async (code) => {
    for (const nested of [true, false]) {
      const connection = Object.assign(new Error('connection could not open'), { code });

      const guarded = vi.fn(() =>
        Promise.reject(nested ? new TypeError('fetch failed', { cause: connection }) : connection),
      );

      const result = await Effect.runPromise(
        invokeMappedHttpAgent(mapped, request, createFetchHttpTransports(guarded)),
      );

      expect(result.attempts).toHaveLength(4);
      expect(guarded).toHaveBeenCalledTimes(4);
    }
  },
);

it('retries a bodyless guarded 503 using its confirmed status', async () => {
  const guarded = vi.fn(() => Promise.resolve(new Response(null, { status: 503 })));

  const result = await Effect.runPromise(
    invokeMappedHttpAgent(mapped, request, createFetchHttpTransports(guarded)),
  );

  expect(result).toMatchObject({ status: 'invocation_error', error: { code: 'http_status' } });
  expect(result.attempts).toHaveLength(4);
  expect(guarded).toHaveBeenCalledTimes(4);
});

it.each([307, 308])('follows a bodyless guarded %i only to the same origin', async (status) => {
  const guarded = vi.fn((url: string) =>
    Promise.resolve(
      url.endsWith('/run')
        ? new Response(null, { status, headers: { location: '/result' } })
        : Response.json({ answer: 'redirected' }),
    ),
  );

  const result = await Effect.runPromise(
    invokeMappedHttpAgent(mapped, request, createFetchHttpTransports(guarded)),
  );

  expect(result.status).toBe('ok');
  expect(guarded).toHaveBeenCalledTimes(2);
  expect(guarded.mock.calls[1]?.[0]).toBe('https://agent.example/result');
});

it('keeps a bodyless guarded success invalid and prohibits replay', async () => {
  const guarded = vi.fn(() => Promise.resolve(new Response(null)));

  const result = await Effect.runPromise(
    invokeMappedHttpAgent(mapped, request, createFetchHttpTransports(guarded)),
  );

  expect(result).toMatchObject({
    status: 'invocation_error',
    error: { code: 'invalid_envelope', applicationStarted: true },
  });
  expect(guarded).toHaveBeenCalledOnce();
});

describe('native stream ownership', () => {
  it('retains terminal evidence when cancellation rejects, without replay', async () => {
    const failure = new Error('cancel rejected');

    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"type":"done","output":"retained"}\n'));
            },
            cancel() {
              return Promise.reject(failure);
            },
          }),
        ),
      ),
    );

    const result = await Effect.runPromise(
      invokeStreamingAgent(streaming('jsonl'), request, createFetchHttpTransports(fetch)),
    );

    expect(result.status).toBe('invocation_error');
    expect(result.diagnostics.httpStatus).toBe(200);
    expect(result.attempts).toHaveLength(1);
    expect(fetch).toHaveBeenCalledOnce();

    if (result.status === 'invocation_error') {
      expect(result.error.code).toBe('network');
      expect(result.error.cause).toMatchObject({ success: { response: { output: 'retained' } } });
      expect(result.rawExcerpt?.text).toContain('retained');
    }
  });

  it('bounds unacknowledged cancellation and prohibits replay', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"type":"done","output":"retained"}\n'));
            },
            cancel() {
              return new Promise<void>(() => {});
            },
          }),
        ),
      ),
    );

    const started = Date.now();

    const result = await Effect.runPromise(
      invokeStreamingAgent(streaming('jsonl'), request, createFetchHttpTransports(fetch)),
    );

    expect(result.status).toBe('invocation_error');
    expect(result.attempts).toHaveLength(1);
    expect(fetch).toHaveBeenCalledOnce();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('keeps a status failure primary when release also fails', async () => {
    const result = await Effect.runPromise(
      invokeStreamingAgent(streaming('jsonl'), request, {
        requestStream: () =>
          Effect.succeed({
            status: 503,
            headers: {},
            read: Effect.never,
            close: Effect.die('release defect'),
          }),
      }),
    );

    expect(result.status).toBe('invocation_error');

    if (result.status === 'invocation_error') {
      expect(result.error.code).toBe('http_status');
      expect(result.error.applicationStarted).toBe(true);
    }

    expect(result.attempts).toHaveLength(1);
  });

  it('keeps primary defects and still closes the response', async () => {
    let closed = false;
    const defect = new Error('read defect');

    const outcome = await Effect.runPromiseExit(
      invokeStreamingAgent(streaming('jsonl'), request, {
        requestStream: () =>
          Effect.succeed({
            status: 200,
            headers: {},
            read: Effect.die(defect),
            close: Effect.sync(() => {
              closed = true;
            }),
          }),
      }),
    );

    expect(closed).toBe(true);
    expect(outcome._tag).toBe('Failure');

    if (outcome._tag === 'Failure')
      expect(
        outcome.cause.reasons.some((reason) => reason._tag === 'Die' && reason.defect === defect),
      ).toBe(true);
  });

  it('returns attempt timeout evidence while another invocation survives', async () => {
    const stalled = invokeStreamingAgent(
      { ...streaming('jsonl'), timeouts: { attempt_ms: 20, idle_ms: 500 } },
      request,
      {
        requestStream: () =>
          Effect.succeed({ status: 200, headers: {}, read: Effect.never, close: Effect.void }),
      },
    );

    const live = liveResponse('{"type":"done","output":"sibling"}\n', 'application/x-ndjson');

    const [failed, success] = await Effect.runPromise(
      Effect.all(
        [
          stalled,
          invokeStreamingAgent(
            streaming('jsonl'),
            request,
            createFetchHttpTransports(() => Promise.resolve(live.response)),
          ),
        ],
        { concurrency: 2 },
      ),
    );

    expect(failed.status === 'invocation_error' && failed.error.code).toBe('timeout');
    expect(success.status).toBe('ok');
    expect(live.cancelled).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'keeps the application idle clock independent of heartbeats, reset=%s',
    async (reset) => {
      let reads = 0;
      const configured = streaming('sse');

      const result = await Effect.runPromise(
        invokeStreamingAgent(
          {
            ...configured,
            timeouts: { attempt_ms: 1000, idle_ms: 35 },
            transport: { ...configured.transport, heartbeat_resets_application_idle: reset },
          },
          request,
          {
            requestStream: () =>
              Effect.succeed({
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
                read: Effect.sleep(15).pipe(
                  Effect.map(() => ({
                    done: false,
                    value: new TextEncoder().encode(
                      ++reads < 5 ? ': heartbeat\n\n' : 'data: {"type":"done","output":"ok"}\n\n',
                    ),
                  })),
                ),
                close: Effect.void,
              }),
          },
        ),
      );

      expect(result.status).toBe(reset ? 'ok' : 'invocation_error');

      if (result.status === 'invocation_error')
        expect(result.error.message).toBe('Streaming application became idle.');
    },
  );

  it('releases a late header response and never redispatches', async () => {
    const cancelled = vi.fn();

    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(new Response(new ReadableStream({ cancel: cancelled }))), 35),
        ),
    );

    const result = await Effect.runPromise(
      invokeStreamingAgent(
        { ...streaming('jsonl'), timeouts: { first_byte_ms: 5, attempt_ms: 1000 } },
        request,
        createFetchHttpTransports(fetch),
      ),
    );

    expect(result.status === 'invocation_error' && result.error.code).toBe('timeout');
    expect(cancelled).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('releases a pending reader on caller cancellation and preserves cancellation evidence', async () => {
    const controller = new AbortController();
    const cancelled = vi.fn();

    const fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            pull() {
              controller.abort();
            },
            cancel: cancelled,
          }),
        ),
      );

    const result = await Effect.runPromise(
      invokeStreamingAgent(streaming('jsonl'), request, {
        ...createFetchHttpTransports(fetch),
        signal: controller.signal,
      }),
    );

    expect(result.status === 'invocation_error' && result.error.code).toBe('cancelled');
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('closes after runtime interruption without manufacturing a cancelled attempt', async () => {
    let closed = false;

    const result = await Effect.runPromiseExit(
      invokeStreamingAgent(streaming('jsonl'), request, {
        requestStream: () =>
          Effect.succeed({
            status: 200,
            headers: {},
            read: Effect.interrupt,
            close: Effect.sync(() => {
              closed = true;
            }),
          }),
      }),
    );

    expect(closed).toBe(true);
    expect(result._tag).toBe('Failure');

    if (result._tag === 'Failure') expect(Cause.hasInterrupts(result.cause)).toBe(true);
  });
});

describe('native incremental framing limits', () => {
  it.each(['sse', 'jsonl'] as const)(
    'accepts every-byte splits and stops before EOF for %s',
    async (framing) => {
      const payload = '{"type":"done","output":"💥"}';

      const bytes = new TextEncoder().encode(
        framing === 'sse' ? `data: ${payload}\n\n` : `${payload}\n`,
      );

      let offset = 0;
      let closed = false;

      const result = await Effect.runPromise(
        invokeStreamingAgent(streaming(framing), request, {
          requestStream: () =>
            Effect.succeed({
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
              read: Effect.suspend(() =>
                offset < bytes.length
                  ? Effect.succeed({ done: false, value: bytes.slice(offset, ++offset) })
                  : Effect.never,
              ),
              close: Effect.sync(() => {
                closed = true;
              }),
            }),
        }),
      );

      expect(result.status === 'ok' && result.report?.ok && result.report.value).toMatchObject({
        output: '💥',
      });
      expect(closed).toBe(true);
    },
  );

  it.each([
    { limits: { event_count: 1 }, source: '{"type":"delta"}\n{"type":"done","output":"no"}\n' },
    { limits: { total_evidence_bytes: 8 }, source: '{"type":"done","output":"no"}\n' },
  ])('enforces authored evidence caps before accepting a terminal', async ({ limits, source }) => {
    const live = liveResponse(source, 'application/x-ndjson');

    const result = await Effect.runPromise(
      invokeStreamingAgent(
        { ...streaming('jsonl'), limits },
        request,
        createFetchHttpTransports(() => Promise.resolve(live.response)),
      ),
    );

    expect(result.status === 'invocation_error' && result.error.code).toBe('output_cap_exceeded');
    expect(live.cancelled).toHaveBeenCalledOnce();
    expect(result.attempts).toHaveLength(1);
  });
});

it('retains completed stream evidence when signal cleanup fails', async () => {
  const controller = new AbortController();

  const remove = vi.spyOn(controller.signal, 'removeEventListener').mockImplementation(() => {
    throw new Error('listener release failed');
  });

  const guarded = vi.fn(() =>
    Promise.resolve(liveResponse('{"type":"done","output":"done"}\n', 'application/json').response),
  );

  try {
    const exit = await Effect.runPromiseExit(
      invokeStreamingAgent(streaming('jsonl'), request, {
        ...createFetchHttpTransports(guarded),
        signal: controller.signal,
      }),
    );

    expect(exit._tag).toBe('Failure');

    if (exit._tag !== 'Failure') throw new Error('Expected cleanup failure.');
    const reason = exit.cause.reasons.find((value) => value._tag === 'Fail');
    expect(reason?._tag === 'Fail' && reason.error).toMatchObject({
      applicationStarted: true,
      result: { status: 'ok', diagnostics: { httpStatus: 200 }, attempts: [{ status: 'ok' }] },
    });
    expect(guarded).toHaveBeenCalledOnce();
  } finally {
    remove.mockRestore();
    controller.abort();
  }
});
