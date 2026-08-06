import { readFileSync } from 'node:fs';

const fixture = JSON.parse(
  readFileSync(
    new URL(
      '../../../../../conformance/fixtures/metric-result/01-valid-pass.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

process.stdin.resume();
process.stdin.on('end', () => process.stdout.write(JSON.stringify(fixture.input)));
