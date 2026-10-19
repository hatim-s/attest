// Stands in for `attest eval run`: records what it was given, then behaves as the request's
// first tag asks. `slow` keeps writing after `run_started` so a test can see it outlive the reader.
import { writeFileSync } from 'node:fs';
import { text } from 'node:stream/consumers';
import { setTimeout as delay } from 'node:timers/promises';

const document = JSON.parse(await text(process.stdin));

writeFileSync('received.json', JSON.stringify({ argv: process.argv.slice(2), document }));

const emit = (event, data) =>
  console.log(
    JSON.stringify({
      schema: 'attest.cli-event',
      sequence: 0,
      time: new Date().toISOString(),
      event,
      data,
    }),
  );

const mode = document.tags?.[0];

if (mode === 'invalid') {
  emit('result', {
    exit_code: 2,
    result: {
      schema: 'attest.cli-result',
      ok: false,
      command: 'eval.run',
      error: {
        code: 'cli_usage',
        message: 'Test nope was not found.',
        hint: 'Run attest test list.',
        retryable: false,
      },
    },
  });
  process.exit(2);
}

if (mode === 'crash') {
  console.error('TypeError: the CLI fell over');
  process.exit(3);
}

console.log('a line that is not an event');

emit('run_started', {
  run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  snapshot_hash: 'a'.repeat(64),
  total_cases: 2,
  concurrency: 1,
  timeout_ms: 60000,
});

if (mode === 'slow') {
  for (let index = 0; index < 40; index += 1) {
    console.log(JSON.stringify({ padding: 'x'.repeat(8192) }));
    await delay(10);
  }
}

writeFileSync('finished', '');
