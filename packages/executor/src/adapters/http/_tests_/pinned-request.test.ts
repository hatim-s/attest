import type { Socket } from 'node:net';

import { expect, it } from 'vitest';

import { startLoopbackServer } from '../../../_tests_/support/loopback-server.js';
import { AgentInvocationError } from '../../../errors.js';
import { openPinnedRequest } from '../pinned-request.js';

it('rejects an unsolicited upgrade and closes its socket', async () => {
  let peer: Socket | undefined;
  let closed: Promise<void> | undefined;
  const fixture = await startLoopbackServer((request, response) => {
    peer = request.socket;
    closed = new Promise((resolve) => request.socket.once('close', resolve));
    response.writeHead(101, { connection: 'Upgrade', upgrade: 'unexpected' });
    response.flushHeaders();
  });
  try {
    await expect(
      openPinnedRequest(
        {
          url: new URL(fixture.url),
          address: '127.0.0.1',
          family: 4,
          loopback: true,
        },
        {
          method: 'GET',
          headers: {},
          signal: AbortSignal.timeout(1_000),
          firstByteTimeoutMs: 1_000,
          errors: {
            aborted: () => new AgentInvocationError('timeout', 'Request aborted.'),
            firstByteTimeout: () => new AgentInvocationError('timeout', 'Headers timed out.'),
            failed: (cause) => new AgentInvocationError('network', 'Request failed.', { cause }),
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'network' });
    expect(closed).toBeDefined();
    await closed;
    expect(peer?.destroyed).toBe(true);
  } finally {
    peer?.destroy();
    await fixture.close();
  }
});
