/**
 * A zero-dependency hostile CLI fixture for runner hardening tests.
 * It intentionally produces valid and invalid agent behaviors without relying on application code.
 */
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS is required for this fixture. */
const { spawn } = require('node:child_process');

const protocol = 'attest.agent/v1alpha1';
const outputChunkBytes = 64 * 1024;

const readRequest = () =>
  new Promise((resolve, reject) => {
    let body = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      body += chunk;
    });
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    process.stdin.on('error', reject);
  });

const responseFor = (request) => ({ protocol, output: `ok:${request.case_id}` });

const utcSecond = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

const validTrace = () => {
  const timestamp = utcSecond();
  return {
    schema: 'attest.trace/v1alpha1',
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
  schema: 'attest.trace/v1alpha1',
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

const writeJson = (response) => {
  process.stdout.write(JSON.stringify(response));
};

const writeChunks = async (value, chunkSize, intervalMilliseconds) => {
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    process.stdout.write(value.slice(offset, offset + chunkSize));
    if (intervalMilliseconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, intervalMilliseconds));
    }
  }
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
  happy: (request) => writeJson(responseFor(request)),
  hang: () => setInterval(() => {}, 1_000),
  'malformed-json': () => process.stdout.write('{"protocol":"attest.agent/v1alpha1","output":'),
  'huge-output': async () => {
    process.stdout.write(`{"protocol":"${protocol}","output":"`);
    // Emit a valid envelope incrementally so output caps can interrupt a live stream.
    await writeChunks('x'.repeat(hugeByteCount()), outputChunkBytes, 0);
    process.stdout.write('"}');
  },
  'partial-stdout': (request) => {
    const response = JSON.stringify(responseFor(request));
    process.stdout.write(response.slice(0, Math.floor(response.length / 2)));
  },
  'stderr-noise': (request) => {
    writeJson(responseFor(request));
    for (let line = 1; line <= 50; line += 1) {
      process.stderr.write(`fixture stderr noise ${line}\n`);
    }
  },
  'nonzero-exit': (request) => {
    writeJson(responseFor(request));
    process.exitCode = 3;
  },
  'orphan-child': (request) => {
    spawnOrphanChild();
    writeJson(responseFor(request));
  },
  'slow-drip': async (request) => {
    const configured = Number.parseInt(process.env.AGENT_DRIP_MS ?? '', 10);
    const intervalMilliseconds =
      Number.isSafeInteger(configured) && configured >= 0 ? configured : 100;
    await writeChunks(JSON.stringify(responseFor(request)), 1, intervalMilliseconds);
  },
  'with-trace': (request) => writeJson({ ...responseFor(request), trace: validTrace() }),
  'malformed-trace': (request) => writeJson({ ...responseFor(request), trace: malformedTrace() }),
};

const behaviorName =
  process.argv.find((argument) => argument.startsWith('--behavior='))?.slice(11) ??
  process.env.AGENT_BEHAVIOR ??
  'happy';

const run = async () => {
  const behavior = behaviors[behaviorName];
  if (!behavior) {
    process.stderr.write(`Unknown agent behavior: ${behaviorName}\n`);
    process.exitCode = 64;
    return;
  }

  try {
    const request = await readRequest();
    await behavior(request);
  } catch (error) {
    process.stderr.write(`Failed to read agent request: ${error.message}\n`);
    process.exitCode = 65;
  }
};

void run();
