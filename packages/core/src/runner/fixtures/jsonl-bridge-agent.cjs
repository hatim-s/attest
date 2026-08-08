/* eslint-disable @typescript-eslint/no-require-imports */
const readline = require('node:readline');

const pending = new Map();
const input = readline.createInterface({ input: process.stdin });

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

input.on('line', (line) => {
  const envelope = JSON.parse(line);
  if (envelope.type === 'cancel') {
    const timer = pending.get(envelope.request_id);
    if (timer !== undefined) clearTimeout(timer);
    pending.delete(envelope.request_id);
    if (process.env.IGNORE_CANCEL !== '1') {
      write({ type: 'cancelled', request_id: envelope.request_id });
    }
    return;
  }
  const action = envelope.request.input?.action;
  if (action === 'non-json') {
    process.stdout.write('not-json\n');
    return;
  }
  if (action === 'exit') {
    process.exit(23);
  }
  const delay = Number(envelope.request.input?.delay_ms ?? 0);
  const timer = setTimeout(() => {
    pending.delete(envelope.request_id);
    write({
      type: 'response',
      request_id: envelope.request_id,
      response: {
        protocol: 'attest.agent/v1alpha1',
        output: envelope.request.input,
      },
    });
  }, delay);
  pending.set(envelope.request_id, timer);
});
