import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_PROTOCOL, type AgentRequest } from '@attest/contracts';
import { describe, expect, it } from 'vitest';

import { invokeAgent } from '../invoke.js';

const MARKER_PROBE_AGENT_PATH = fileURLToPath(
  new URL('./fixtures/marker-probe-agent.cjs', import.meta.url),
);

const request: AgentRequest = {
  protocol: AGENT_PROTOCOL,
  run_id: '01J9ZK7Q2M5X8W4V3T2R1QPN0M',
  case_id: 'invoke-test',
  input: {},
};

describe('invokeAgent', { timeout: 30_000 }, () => {
  it('creates isolated retry directories beneath an explicit working-directory test seam', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'attest-marker-probe-'));
    const statePath = join(stateDirectory, 'state');

    try {
      const result = await invokeAgent(
        { type: 'cli', command: [process.execPath, MARKER_PROBE_AGENT_PATH] },
        request,
        {
          outputCapBytes: 1_024 * 1_024,
          retries: 1,
          terminationGraceMs: 100,
          timeoutMs: 8_000,
          env: { PATH: process.env.PATH ?? '', MARKER_PROBE_STATE_FILE: statePath },
          workingDirectory: stateDirectory,
        },
      );

      expect(result).toMatchObject({
        status: 'ok',
        report: { ok: true, value: { output: 'attempt isolated' } },
      });
      expect(result.attempts).toHaveLength(2);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects %s retries before sending a request',
    async (retries) => {
      const controller = new AbortController();
      let requests = 0;

      // Cuts off a retry loop that never ends so the unfixed path fails instead of hanging.
      const httpFetch = (): Promise<Response> => {
        requests += 1;

        if (requests < 6) return Promise.resolve(new Response('', { status: 500 }));
        controller.abort();

        return Promise.reject(new DOMException('Retry loop cut off.', 'AbortError'));
      };

      await expect(
        invokeAgent({ type: 'http', url: 'https://agent.invalid/' }, request, {
          outputCapBytes: 1_024,
          retries,
          timeoutMs: 1_000,
          httpFetch,
          signal: controller.signal,
        }),
      ).rejects.toThrow(/retries/u);
      expect(requests).toBe(0);
    },
  );
});
