'use strict';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const behavior = process.argv[2] || 'echo';
  if (behavior === 'hang') {
    setInterval(() => undefined, 1_000);
    return;
  }
  if (behavior === 'invalid') {
    process.stderr.write(`diagnostic:${process.env.ATTEST_TEST_SECRET || ''}`);
    process.stdout.write(`invalid:${process.env.ATTEST_TEST_SECRET || ''}`);
    return;
  }
  if (behavior === 'exit') {
    process.exitCode = 23;
    return;
  }

  const request = JSON.parse(input);
  const response = {
    protocol: 'attest.agent-invocation',
    output: {
      argv: process.argv.slice(3),
      handshake: {
        case_id: process.env.ATTEST_CASE_ID,
        protocol: process.env.ATTEST_PROTOCOL,
        run_id: process.env.ATTEST_RUN_ID,
      },
      input: request.input,
      secret: process.env.ATTEST_TEST_SECRET,
    },
  };
  if (behavior === 'trace') {
    response.trace = {
      schema: 'attest.trace',
      trace_id: 'connection-trace',
      spans: [
        {
          span_id: 'span-1',
          parent_span_id: null,
          name: 'agent.test',
          kind: 'agent',
          start_time: '2026-08-08T00:00:00Z',
          end_time: '2026-08-08T00:00:01Z',
          status: { code: 'ok' },
        },
      ],
    };
  }
  process.stdout.write(JSON.stringify(response));
});
