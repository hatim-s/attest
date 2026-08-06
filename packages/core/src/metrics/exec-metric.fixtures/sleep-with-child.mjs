import { spawn } from 'node:child_process';

const markerPath = process.argv[2];
const childSource = `
  import { writeFileSync } from 'node:fs';
  const markerPath = process.argv[1];
  setTimeout(() => writeFileSync(markerPath, 'orphan survived'), 300);
  setInterval(() => {}, 1_000);
`;

spawn(process.execPath, ['--input-type=module', '--eval', childSource, markerPath], {
  stdio: 'ignore',
});
setInterval(() => {}, 1_000);
