'use strict';

// Echoes the invocation back so tests can assert argv, handshake env, and input reach the agent.
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  process.stdout.write(
    JSON.stringify({
      protocol: 'attest.agent-invocation',
      output: {
        argv: process.argv.slice(3),
        handshake: {
          case_id: process.env.ATTEST_CASE_ID,
          protocol: process.env.ATTEST_PROTOCOL,
          run_id: process.env.ATTEST_RUN_ID,
        },
        input: request.input,
      },
    }),
  );
});
