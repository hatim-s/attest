let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);

// Echo the normalized input so the acceptance journey stays local and deterministic.
process.stdout.write(
  JSON.stringify({ protocol: 'attest.agent-invocation', output: request.input }),
);
