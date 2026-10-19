import { AGENT_PROTOCOL, traceSchema, type Span } from '@attest/contracts';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentInvocation } from '../index.js';
import { createPiHandler } from '../pi.js';

const MOCK_PI = fileURLToPath(new URL('./fixtures/mock-pi.cjs', import.meta.url));

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-client-pi-'));

  directories.push(directory);

  return directory;
};

const invocation: AgentInvocation = {
  protocol: AGENT_PROTOCOL,
  run_id: '01J9Z3K4X5Y6Z7A8B9C0D1E2F3',
  case_id: 'case-1',
  input: { prompt: 'Write answer.ts' },
  callback: { url: 'http://127.0.0.1:1/attest/completions/run/case', token: 'unused' },
};

const spanNamed = (spans: Span[], name: string): Span | undefined =>
  spans.find((span) => span.name === name);

describe('createPiHandler', () => {
  it('returns the final text, the changed file and a trace with the tool call', async () => {
    const workspace = await temporaryDirectory();

    await writeFile(join(workspace, 'notes.md'), 'present before the run\n');

    const handler = createPiHandler({
      argv: [process.execPath, MOCK_PI],
      model: 'mock/pi-1',
      workspace: () => Promise.resolve(workspace),
    });

    const result = await handler(invocation, { signal: new AbortController().signal });

    // The final message_end carries a raw U+2028; only LF-only framing keeps it whole.
    expect(result).toMatchObject({ output: 'Wrote answer.ts' });
    // notes.md existed with the same bytes before the run, so only answer.ts is an artifact.
    expect(result.artifacts).toEqual([
      {
        kind: 'inline',
        path: 'answer.ts',
        media_type: 'text/typescript',
        encoding: 'utf8',
        content: 'export const answer = 42;\n',
      },
    ]);

    const trace = traceSchema.parse(result.trace);
    const root = spanNamed(trace.spans, 'agent.run');
    const tool = spanNamed(trace.spans, 'tool.write');
    const turns = trace.spans.filter((span) => span.kind === 'llm');

    expect(root).toMatchObject({ kind: 'agent', parent_span_id: null, status: { code: 'ok' } });
    expect(turns).toHaveLength(2);
    expect(turns[0]?.attributes).toMatchObject({
      'gen_ai.request.model': 'mock/pi-1',
      'gen_ai.response.model': 'mock/pi-1',
      'gen_ai.usage.input_tokens': 12,
    });
    expect(tool).toMatchObject({
      kind: 'tool',
      parent_span_id: turns[0]?.span_id,
      status: { code: 'ok' },
      attributes: { 'gen_ai.tool.name': 'write', 'gen_ai.tool.call.id': 'call_write_1' },
    });
    expect(JSON.parse(String(tool?.attributes?.['gen_ai.tool.call.arguments']))).toEqual({
      path: 'answer.ts',
      content: 'export const answer = 42;\n',
    });
  });

  it('reports a provider failure as an error completion', async () => {
    const handler = createPiHandler({ argv: [process.execPath, MOCK_PI, '--mock-fail'] });

    const result = await handler(invocation, { signal: new AbortController().signal });

    expect(result).toMatchObject({
      error: { code: 'pi_agent_failed', message: '--mock-fail requested' },
      artifacts: [],
    });
    expect(spanNamed(traceSchema.parse(result.trace).spans, 'agent.run')?.status).toEqual({
      code: 'error',
      message: '--mock-fail requested',
    });
  });

  it('kills Pi when the invocation is aborted and still reports the trace and changed files', async () => {
    const workspace = await temporaryDirectory();
    const pidFile = join(await temporaryDirectory(), 'mock-pi.pid');
    const controller = new AbortController();

    const handler = createPiHandler({
      argv: [process.execPath, MOCK_PI, '--mock-delay-ms=50', `--mock-pid-file=${pidFile}`],
      workspace: () => Promise.resolve(workspace),
    });

    const pending = handler(invocation, { signal: controller.signal });

    // The write tool has run, so the abort lands mid-run with spans open.
    await expect.poll(() => existsSync(join(workspace, 'answer.ts'))).toBe(true);
    controller.abort();
    const result = await pending;
    const pid = Number(await readFile(pidFile, 'utf8'));

    expect(result).toMatchObject({
      error: { code: 'cancelled' },
      artifacts: [{ path: 'answer.ts' }],
    });
    expect(spanNamed(traceSchema.parse(result.trace).spans, 'agent.run')?.status).toEqual({
      code: 'error',
      message: 'The invocation was cancelled.',
    });
    // Signal 0 only probes: it throws ESRCH once the process is gone.
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/u);
  });
});
