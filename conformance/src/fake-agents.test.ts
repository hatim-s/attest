import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { parseAgentRequest, parseAgentResponse } from '@attest/contracts';
import { describe, expect, it } from 'vitest';

const fixtureTimeoutMilliseconds = 5_000;
const cliAgentPath = fileURLToPath(new URL('../fake-agents/cli-agent.cjs', import.meta.url));
const httpAgentPath = fileURLToPath(new URL('../fake-agents/http-agent.cjs', import.meta.url));
const requestEnvelope = {
  protocol: 'attest.agent/v1alpha1',
  run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  case_id: 'greeting-basic',
  input: { question: 'What is the capital of France?' },
};

/** Runs one CLI fixture invocation and fails fast if it does not close. */
const runCliAgent = async (behavior: string) => {
  const signal = AbortSignal.timeout(fixtureTimeoutMilliseconds);
  const child = spawn(process.execPath, [cliAgentPath, `--behavior=${behavior}`], {
    stdio: 'pipe',
  });
  let stdout = '';
  let stderr = '';

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(JSON.stringify(requestEnvelope));

  const close = once(child, 'close').then(([exitCode]) => ({ exitCode, stdout, stderr }));
  const timeout = new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        child.kill('SIGKILL');
        reject(new Error(`CLI fixture timed out: ${behavior}`));
      },
      { once: true },
    );
  });

  return Promise.race([close, timeout]);
};

/** Starts the HTTP fixture and resolves only after its required listening line arrives. */
const startHttpAgent = async () => {
  const signal = AbortSignal.timeout(fixtureTimeoutMilliseconds);
  const child = spawn(process.execPath, [httpAgentPath], { stdio: 'pipe' });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  const port = await new Promise<number>((resolve, reject) => {
    let stdout = '';
    const fail = (message: string) => reject(new Error(message));
    signal.addEventListener(
      'abort',
      () => {
        child.kill('SIGKILL');
        fail('HTTP fixture did not report a listening port');
      },
      { once: true },
    );
    child.once('error', (error) => fail(`HTTP fixture failed: ${error.message}`));
    child.once('close', (exitCode) => fail(`HTTP fixture exited early with code ${exitCode}`));
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const [line] = stdout.split('\n');
      const match = line?.match(/^LISTENING (\d+)$/);
      if (match?.[1]) {
        resolve(Number.parseInt(match[1], 10));
      }
    });
  });

  return {
    port,
    stop: async () => {
      const closed = once(child, 'close');
      child.kill('SIGTERM');
      await closed;
    },
  };
};

describe('hostile fake agents', () => {
  it('returns a parseable happy CLI response', async () => {
    const parsedRequest = parseAgentRequest(requestEnvelope);
    expect(parsedRequest.ok).toBe(true);

    const result = await runCliAgent('happy');
    expect(result.exitCode).toBe(0);
    const parsedResponse = parseAgentResponse(JSON.parse(result.stdout));
    expect(parsedResponse.ok).toBe(true);
    if (!parsedResponse.ok) {
      return;
    }

    expect('output' in parsedResponse.value).toBe(true);
    if (!('output' in parsedResponse.value)) {
      return;
    }

    expect(parsedResponse.value.output).toBe('ok:greeting-basic');
  });

  it('returns a valid trace with no warnings', async () => {
    const result = await runCliAgent('with-trace');
    const parsedResponse = parseAgentResponse(JSON.parse(result.stdout));
    expect(parsedResponse.ok).toBe(true);
    if (!parsedResponse.ok) {
      return;
    }

    expect(parsedResponse.value.trace).toBeDefined();
    expect(parsedResponse.warnings).toEqual([]);
  });

  it('degrades a malformed trace into an invalid_trace warning', async () => {
    const result = await runCliAgent('malformed-trace');
    const parsedResponse = parseAgentResponse(JSON.parse(result.stdout));
    expect(parsedResponse.ok).toBe(true);
    if (!parsedResponse.ok) {
      return;
    }

    expect(parsedResponse.value.trace).toBeUndefined();
    expect(parsedResponse.warnings).toContainEqual(
      expect.objectContaining({ code: 'invalid_trace' }),
    );
  });

  it('keeps stderr noise out of the CLI response stream', async () => {
    const result = await runCliAgent('stderr-noise');
    expect(result.stderr.split('\n').filter(Boolean)).toHaveLength(50);
    const parsedResponse = parseAgentResponse(JSON.parse(result.stdout));
    expect(parsedResponse.ok).toBe(true);
  });

  it('exposes the non-zero CLI exit code', async () => {
    const result = await runCliAgent('nonzero-exit');
    expect(result.exitCode).toBe(3);
  });

  it('returns a parseable happy HTTP response', async () => {
    const agent = await startHttpAgent();
    try {
      const response = await fetch(`http://127.0.0.1:${agent.port}/happy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestEnvelope),
        signal: AbortSignal.timeout(fixtureTimeoutMilliseconds),
      });
      const parsedResponse = parseAgentResponse(await response.json());
      expect(response.status).toBe(200);
      expect(parsedResponse.ok).toBe(true);
      if (!parsedResponse.ok) {
        return;
      }

      expect('output' in parsedResponse.value).toBe(true);
      if (!('output' in parsedResponse.value)) {
        return;
      }

      expect(parsedResponse.value.output).toBe('ok:greeting-basic');
    } finally {
      await agent.stop();
    }
  });
});
