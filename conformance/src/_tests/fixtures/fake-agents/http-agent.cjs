/**
 * A zero-dependency hostile HTTP fixture for runner hardening tests.
 * It mirrors CLI failures over HTTP so transport-specific runner behavior stays testable.
 */
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS is required for this fixture. */
const http = require('node:http');
const { spawn } = require('node:child_process');

const protocol = 'attest.agent-invocation';
const outputChunkBytes = 64 * 1024;

const readRequest = (request) =>
  new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });

const responseFor = (request) => ({ protocol, output: `ok:${request.case_id}` });

const utcSecond = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

const validTrace = () => {
  const timestamp = utcSecond();
  return {
    schema: 'attest.trace',
    trace_id: 'fixture-trace',
    spans: [
      {
        span_id: 'agent-span',
        parent_span_id: null,
        name: 'agent.run',
        kind: 'agent',
        start_time: timestamp,
        end_time: timestamp,
        status: { code: 'ok' },
      },
    ],
  };
};

const malformedTrace = () => ({
  schema: 'attest.trace',
  trace_id: 'fixture-trace',
  spans: [
    {
      span_id: 'agent-span',
      parent_span_id: null,
      name: 'agent.run',
      kind: 'agent',
      start_time: 'not-a-timestamp',
      end_time: 'also-not-a-timestamp',
      status: { code: 'ok' },
    },
  ],
});

const writeJson = (response, value) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(value));
};

const writeChunks = async (response, value, chunkSize, intervalMilliseconds) => {
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    response.write(value.slice(offset, offset + chunkSize));
    if (intervalMilliseconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, intervalMilliseconds));
    }
  }
  response.end();
};

const hugeByteCount = () => {
  const configured = Number.parseInt(process.env.AGENT_HUGE_BYTES ?? '', 10);
  return Number.isSafeInteger(configured) && configured >= 0 ? configured : 12 * 1024 * 1024;
};

const spawnOrphanChild = () => {
  const heartbeatFile = process.env.ORPHAN_HEARTBEAT_FILE;
  if (!heartbeatFile) {
    return;
  }

  const childProgram = `const fs = require('node:fs'); const file = process.argv[1]; fs.appendFileSync(file, 'PID ' + process.pid + '\\n'); setInterval(() => fs.appendFileSync(file, new Date().toISOString() + '\\n'), 200);`;
  const child = spawn(process.execPath, ['-e', childProgram, heartbeatFile], {
    detached: true,
    stdio: 'ignore',
  });
  // The detached child must outlive this fixture so runners can prove tree cleanup reaps it.
  child.unref();
};

const behaviors = {
  happy: (request, response) => writeJson(response, responseFor(request)),
  hang: () => {},
  'malformed-json': (_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end('{"protocol":"attest.agent-invocation","output":');
  },
  'huge-output': async (_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.write(`{"protocol":"${protocol}","output":"`);
    // Emit a valid envelope incrementally so response caps can interrupt a live stream.
    await writeChunks(response, `${'x'.repeat(hugeByteCount())}"}`, outputChunkBytes, 0);
  },
  'partial-stdout': (request, response) => {
    response.setHeader('content-type', 'application/json');
    const value = JSON.stringify(responseFor(request));
    response.end(value.slice(0, Math.floor(value.length / 2)));
  },
  'stderr-noise': (request, response) => {
    for (let line = 1; line <= 50; line += 1) {
      process.stderr.write(`fixture stderr noise ${line}\n`);
    }
    writeJson(response, responseFor(request));
  },
  'orphan-child': (request, response) => {
    spawnOrphanChild();
    writeJson(response, responseFor(request));
  },
  'slow-drip': async (request, response) => {
    const configured = Number.parseInt(process.env.AGENT_DRIP_MS ?? '', 10);
    const intervalMilliseconds =
      Number.isSafeInteger(configured) && configured >= 0 ? configured : 100;
    response.setHeader('content-type', 'application/json');
    await writeChunks(response, JSON.stringify(responseFor(request)), 1, intervalMilliseconds);
  },
  'with-trace': (request, response) =>
    writeJson(response, { ...responseFor(request), trace: validTrace() }),
  'malformed-trace': (request, response) =>
    writeJson(response, { ...responseFor(request), trace: malformedTrace() }),
};

const server = http.createServer(async (request, response) => {
  if (request.method !== 'POST') {
    response.statusCode = 405;
    response.end('POST required');
    return;
  }

  let envelope;
  try {
    envelope = await readRequest(request);
  } catch (error) {
    response.statusCode = 400;
    response.end(`Invalid JSON request: ${error.message}`);
    return;
  }

  const behaviorName = new URL(request.url, 'http://localhost').pathname.slice(1);
  if (behaviorName === 'status-500' || behaviorName === 'status-404') {
    response.statusCode = Number.parseInt(behaviorName.slice(7), 10);
    response.end(behaviorName);
    return;
  }

  const behavior = behaviors[behaviorName];
  if (!behavior) {
    response.statusCode = 404;
    response.end(`Unknown agent behavior: ${behaviorName}`);
    return;
  }

  await behavior(envelope, response);
});

const shutdown = () => server.close(() => process.exit(0));

server.on('error', (error) => {
  process.stderr.write(`HTTP fixture failed: ${error.message}\n`);
  process.exitCode = 1;
});
server.listen(Number.parseInt(process.env.PORT ?? '0', 10) || 0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') {
    process.stderr.write('HTTP fixture did not expose a TCP port\n');
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`LISTENING ${address.port}\n`);
});
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
