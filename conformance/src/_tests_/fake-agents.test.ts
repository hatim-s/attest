import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAgentRequest, parseAgentResponse } from '@attest/contracts';
import { describe, expect, it } from 'vitest';

const fixtureTimeoutMilliseconds = 5_000;
const cliAgentPath = fileURLToPath(
  new URL('./fixtures/fake-agents/cli-agent.cjs', import.meta.url),
);
const httpAgentPath = fileURLToPath(
  new URL('./fixtures/fake-agents/http-agent.cjs', import.meta.url),
);
const requestEnvelope = {
  protocol: 'attest.agent-invocation',
  run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  case_id: 'greeting-basic',
  input: { question: 'What is the capital of France?' },
};

type FixtureProcess = {
  child: ChildProcess;
  stdout: () => string;
  exited: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  dispose: () => Promise<void>;
};

/** Spawns a fake agent and owns every timer, listener, stream, and exit path. */
const spawnFixtureAgent = (
  args: string[],
  environment: Record<string, string> = {},
): FixtureProcess => {
  const child = spawn(process.execPath, args, {
    env: { ...process.env, ...environment },
    stdio: 'pipe',
  });
  let output = '';
  const abortController = new AbortController();
  const deadlineTimer: ReturnType<typeof setTimeout> = setTimeout(
    () => abortController.abort(),
    fixtureTimeoutMilliseconds,
  );
  let disposed = false;
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    output += chunk;
  });

  const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
    },
  );

  const dispose = async (): Promise<void> => {
    if (disposed) {
      await exited;
      return;
    }
    disposed = true;
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
    }
    abortController.abort();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    await exited;
  };

  const abortListener = () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  };
  abortController.signal.addEventListener('abort', abortListener, { once: true });
  return {
    child,
    stdout: () => output,
    exited,
    dispose: async () => {
      abortController.signal.removeEventListener('abort', abortListener);
      await dispose();
    },
  };
};

/** Starts the HTTP fixture and waits for LISTENING without leaving a readiness timer armed. */
const startHttpAgent = async (): Promise<{ port: number; dispose: () => Promise<void> }> => {
  const agent = spawnFixtureAgent([httpAgentPath]);
  let readinessTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let output = '';
      const fail = (error: Error) => reject(error);
      readinessTimer = setTimeout(
        () => fail(new Error('HTTP fixture did not report a listening port')),
        fixtureTimeoutMilliseconds,
      );
      agent.child.once('error', (error) => fail(error));
      agent.child.once('close', (exitCode) => fail(new Error(`HTTP fixture exited: ${exitCode}`)));
      agent.child.stdout?.on('data', (chunk: string) => {
        output += chunk;
        const match = output.match(/(?:^|\n)LISTENING (\d+)\n?/);
        if (match?.[1]) {
          if (readinessTimer !== undefined) {
            clearTimeout(readinessTimer);
            readinessTimer = undefined;
          }
          resolve(Number.parseInt(match[1], 10));
        }
      });
    });

    return {
      port,
      dispose: async () => {
        const killTimer = setTimeout(() => {
          if (agent.child.exitCode === null && agent.child.signalCode === null) {
            agent.child.kill('SIGKILL');
          }
        }, 1_000);
        if (agent.child.exitCode === null && agent.child.signalCode === null) {
          agent.child.kill('SIGTERM');
        }
        await agent.exited;
        clearTimeout(killTimer);
        await agent.dispose();
      },
    };
  } catch (error) {
    if (readinessTimer !== undefined) {
      clearTimeout(readinessTimer);
    }
    await agent.dispose();
    throw error;
  }
};

/** Parses serialized fixture output while treating malformed JSON as a failed response. */
const parseSerializedResponse = (value: string) => {
  try {
    return parseAgentResponse(JSON.parse(value) as unknown);
  } catch {
    return { ok: false as const };
  }
};

const wait = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

/** Waits briefly for an asynchronously spawned orphan to create its heartbeat file. */
const waitForFile = async (path: string): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      statSync(path);
      return;
    } catch {
      await wait(25);
    }
  }
  throw new Error(`Heartbeat file was not created: ${path}`);
};

describe('hostile fake agents', () => {
  it('returns a parseable happy CLI response', async () => {
    const agent = spawnFixtureAgent([cliAgentPath, '--behavior=happy']);
    try {
      const parsedRequest = parseAgentRequest(requestEnvelope);
      expect(parsedRequest.ok).toBe(true);
      agent.child.stdin?.end(JSON.stringify(requestEnvelope));
      const result = await agent.exited;
      expect(result.exitCode).toBe(0);
      const parsedResponse = parseSerializedResponse(agent.stdout());
      expect(parsedResponse.ok).toBe(true);
      if (parsedResponse.ok && 'output' in parsedResponse.value) {
        expect(parsedResponse.value.output).toBe('ok:greeting-basic');
      }
    } finally {
      await agent.dispose();
    }
  });

  it('returns a valid trace with no warnings', async () => {
    const agent = spawnFixtureAgent([cliAgentPath, '--behavior=with-trace']);
    try {
      agent.child.stdin?.end(JSON.stringify(requestEnvelope));
      await agent.exited;
      const parsedResponse = parseSerializedResponse(agent.stdout());
      expect(parsedResponse.ok).toBe(true);
      if (parsedResponse.ok) {
        expect(parsedResponse.value.trace).toBeDefined();
        expect(parsedResponse.warnings).toEqual([]);
      }
    } finally {
      await agent.dispose();
    }
  });

  it('degrades a malformed trace into an invalid_trace warning', async () => {
    const agent = spawnFixtureAgent([cliAgentPath, '--behavior=malformed-trace']);
    try {
      agent.child.stdin?.end(JSON.stringify(requestEnvelope));
      await agent.exited;
      const parsedResponse = parseSerializedResponse(agent.stdout());
      expect(parsedResponse.ok).toBe(true);
      if (parsedResponse.ok) {
        expect(parsedResponse.value.trace).toBeUndefined();
        expect(parsedResponse.warnings).toContainEqual(
          expect.objectContaining({ code: 'invalid_trace' }),
        );
      }
    } finally {
      await agent.dispose();
    }
  });

  it('keeps stderr noise out of the CLI response stream', async () => {
    const agent = spawnFixtureAgent([cliAgentPath, '--behavior=stderr-noise']);
    try {
      let stderr = '';
      agent.child.stderr?.setEncoding('utf8');
      agent.child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      agent.child.stdin?.end(JSON.stringify(requestEnvelope));
      await agent.exited;
      expect(stderr.split('\n').filter(Boolean)).toHaveLength(50);
      expect(parseSerializedResponse(agent.stdout()).ok).toBe(true);
    } finally {
      await agent.dispose();
    }
  });

  it('exposes the non-zero CLI exit code', async () => {
    const agent = spawnFixtureAgent([cliAgentPath, '--behavior=nonzero-exit']);
    try {
      agent.child.stdin?.end(JSON.stringify(requestEnvelope));
      const result = await agent.exited;
      expect(result.exitCode).toBe(3);
    } finally {
      await agent.dispose();
    }
  });

  it('kills a hanging CLI agent within a bounded test', async () => {
    const agent = spawnFixtureAgent([cliAgentPath, '--behavior=hang']);
    try {
      agent.child.stdin?.end(JSON.stringify(requestEnvelope));
      await wait(300);
      expect(agent.child.exitCode).toBeNull();
      expect(agent.child.signalCode).toBeNull();
    } finally {
      await agent.dispose();
    }
  });

  for (const behavior of ['malformed-json', 'partial-stdout']) {
    it(`${behavior} fails response parsing`, async () => {
      const agent = spawnFixtureAgent([cliAgentPath, `--behavior=${behavior}`]);
      try {
        agent.child.stdin?.end(JSON.stringify(requestEnvelope));
        await agent.exited;
        expect(parseSerializedResponse(agent.stdout()).ok).toBe(false);
      } finally {
        await agent.dispose();
      }
    });
  }

  it('parses the bounded huge-output response', async () => {
    const agent = spawnFixtureAgent([cliAgentPath, '--behavior=huge-output'], {
      AGENT_HUGE_BYTES: '2048',
    });
    try {
      agent.child.stdin?.end(JSON.stringify(requestEnvelope));
      await agent.exited;
      const parsedResponse = parseSerializedResponse(agent.stdout());
      expect(parsedResponse.ok).toBe(true);
      if (parsedResponse.ok && 'output' in parsedResponse.value) {
        expect(parsedResponse.value.output).toHaveLength(2048);
      }
    } finally {
      await agent.dispose();
    }
  });

  it('completes and parses slow-drip with no delay', async () => {
    const agent = spawnFixtureAgent([cliAgentPath, '--behavior=slow-drip'], {
      AGENT_DRIP_MS: '0',
    });
    try {
      agent.child.stdin?.end(JSON.stringify(requestEnvelope));
      await agent.exited;
      expect(parseSerializedResponse(agent.stdout()).ok).toBe(true);
    } finally {
      await agent.dispose();
    }
  });

  it('proves the orphan child survives its parent, then kills it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'attest-orphan-'));
    const heartbeatFile = join(directory, 'heartbeat.log');
    const agent = spawnFixtureAgent([cliAgentPath, '--behavior=orphan-child'], {
      ORPHAN_HEARTBEAT_FILE: heartbeatFile,
    });
    let orphanPid: number | undefined;
    try {
      agent.child.stdin?.end(JSON.stringify(requestEnvelope));
      await agent.exited;
      await waitForFile(heartbeatFile);
      const sizeAtParentExit = statSync(heartbeatFile).size;
      await wait(500);
      const contents = readFileSync(heartbeatFile, 'utf8');
      expect(contents.length).toBeGreaterThan(sizeAtParentExit);
      const pid = Number.parseInt(contents.split('\n')[0]?.replace(/^PID /, '') ?? '', 10);
      expect(Number.isInteger(pid)).toBe(true);
      orphanPid = pid;
    } finally {
      if (orphanPid !== undefined) {
        try {
          process.kill(orphanPid, 'SIGKILL');
        } catch {
          // The orphan may have exited between the heartbeat assertion and cleanup.
        }
      }
      await agent.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('returns HTTP status 500 and closes the connection', async () => {
    const agent = await startHttpAgent();
    try {
      const response = await fetch(`http://127.0.0.1:${agent.port}/status-500`, {
        method: 'POST',
        body: JSON.stringify(requestEnvelope),
      });
      expect(response.status).toBe(500);
      await expect(response.text()).resolves.toBe('status-500');
    } finally {
      await agent.dispose();
    }
  });

  it('returns HTTP status 404 and closes the connection', async () => {
    const agent = await startHttpAgent();
    try {
      const response = await fetch(`http://127.0.0.1:${agent.port}/status-404`, {
        method: 'POST',
        body: JSON.stringify(requestEnvelope),
      });
      expect(response.status).toBe(404);
      await expect(response.text()).resolves.toBe('status-404');
    } finally {
      await agent.dispose();
    }
  });

  it('returns a parseable happy HTTP response', async () => {
    const agent = await startHttpAgent();
    try {
      const response = await fetch(`http://127.0.0.1:${agent.port}/happy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestEnvelope),
      });
      const parsedResponse = parseAgentResponse(await response.json());
      expect(response.status).toBe(200);
      expect(parsedResponse.ok).toBe(true);
      if (parsedResponse.ok && 'output' in parsedResponse.value) {
        expect(parsedResponse.value.output).toBe('ok:greeting-basic');
      }
    } finally {
      await agent.dispose();
    }
  });
});
