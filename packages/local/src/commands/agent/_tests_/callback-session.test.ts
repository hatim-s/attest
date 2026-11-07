import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  AGENT_COMPLETION_PROTOCOL,
  AGENT_PROTOCOL,
  agentRequestSchema,
  parseWithSchemaSync,
  type AgentRequest,
} from '@attest/contracts';
import { expect, it } from 'vitest';
import { startCallbackSession } from '../adapter/callback-session.js';

it('keeps the receiver alive while close joins every accepted invocation', async () => {
  const received: AgentRequest[] = [];

  const server = createServer((request, response) => {
    void (async () => {
      let body = '';

      for await (const chunk of request) body += String(chunk);
      received.push(parseWithSchemaSync(agentRequestSchema, JSON.parse(body)));
      response.writeHead(202).end();
    })().catch(() => response.writeHead(500).end());
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // SAFETY: listen above binds TCP on loopback and has completed successfully.
  const address = server.address() as AddressInfo;

  const session = await startCallbackSession({
    kind: 'callback',
    agent: {
      schema: 'attest.agent',
      id: 'callback',
      name: 'Callback',
      transport: {
        kind: 'callback',
        lifecycle: 'external',
        trigger: { url: `http://127.0.0.1:${address.port}/trigger`, method: 'POST' },
      },
      timeouts: { attempt_ms: 2000 },
    },
    trigger: { headers: {}, query: {} },
    secrets: [],
  });

  const controller = new AbortController();

  const request = (id: string): AgentRequest => ({
    protocol: AGENT_PROTOCOL,
    run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    case_id: id,
    input: 'work',
  });

  const first = session.invoke(request('first'), controller.signal);
  const second = session.invoke(request('second'), controller.signal);

  /** Delivers only the selected case, leaving its sibling admitted and waiting. */
  const complete = async (id: string): Promise<string> => {
    const accepted = received.find((item) => item.case_id === id);

    if (accepted?.callback === undefined) throw new Error('Expected callback receipt.');

    const response = await fetch(accepted.callback.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accepted.callback.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        protocol: AGENT_COMPLETION_PROTOCOL,
        run_id: accepted.run_id,
        case_id: accepted.case_id,
        output: id,
      }),
    });

    expect(response.status).toBe(202);
    await response.arrayBuffer();

    return accepted.callback.url;
  };

  try {
    await expect.poll(() => received.length, { timeout: 3000 }).toBe(2);
    let closed = false;

    const closing = session.close().then(() => {
      closed = true;
    });

    await expect(session.invoke(request('late'))).rejects.toMatchObject({ code: 'cancelled' });
    await complete('first');
    expect((await first).status).toBe('ok');
    expect(closed).toBe(false);
    const url = await complete('second');
    expect((await second).status).toBe('ok');
    await closing;
    expect(closed).toBe(true);
    await expect(fetch(url)).rejects.toThrow();
    await session.close();
  } finally {
    controller.abort();
    await Promise.allSettled([first, second]);
    await session.close().finally(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
          server.closeAllConnections();
        }),
    );
  }
});
