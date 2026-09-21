import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { invokeAgent, justBashIsolation } from '../../dist/index.js';

const request = {
  protocol: 'attest.agent-invocation',
  run_id: 'run',
  case_id: 'case',
  input: 'hello',
};
const options = { timeoutMs: 5000, outputCapBytes: 4096, env: {}, retries: 0 };

test('executes a child with the current host runtime and validates its envelope', async () => {
  const script =
    'process.stdout.write(JSON.stringify({protocol:"attest.agent-invocation",output:"ok"}))';
  const result = await invokeAgent(
    { type: 'cli', command: [process.execPath, '-e', script] },
    request,
    options,
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.report?.ok, true);
});

test('invokes an HTTP agent with bounded response parsing', async () => {
  const server = createServer((req, res) => {
    req.resume();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ protocol: 'attest.agent-invocation', output: 'ok' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const result = await invokeAgent(
      { type: 'http', url: `http://127.0.0.1:${address.port}` },
      request,
      options,
    );
    assert.equal(result.status, 'ok');
    assert.equal(result.report?.ok, true);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('times out and reaps a child under the current host runtime', async () => {
  const script = 'process.stderr.write(String(process.pid)); setInterval(() => undefined, 1000)';
  const result = await invokeAgent(
    { type: 'cli', command: [process.execPath, '-e', script] },
    request,
    { ...options, timeoutMs: 250, terminationGraceMs: 100 },
  );

  assert.equal(result.status, 'invocation_error');
  assert.equal(result.error?.code, 'timeout');
  assert.equal(result.diagnostics.unreapedProcessIds, undefined);
  const processId = Number(result.diagnostics.stderrExcerpt);
  assert.equal(Number.isSafeInteger(processId), true);
  assert.throws(
    () => process.kill(processId, 0),
    (error) => error?.code === 'ESRCH',
  );
});

test('isolates virtual case files and rejects use after disposal', async () => {
  const factory = justBashIsolation({ files: { 'input.txt': 'seed' } });
  const context = {
    runId: 'run',
    testId: 'test',
    caseId: 'case',
    configuredIndex: 0,
    workerIndex: 0,
    signal: new AbortController().signal,
  };
  const [first, second] = await Promise.all([factory(context), factory(context)]);
  try {
    assert.equal((await first.exec('echo changed > input.txt; cat input.txt')).stdout, 'changed\n');
    assert.equal(await second.readFile('input.txt'), 'seed');
    assert.notEqual((await first.exec('node -e "process.exit(0)"')).exitCode, 0);
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
  }
  assert.throws(() => first.exec('echo late'), /disposed/);
});
