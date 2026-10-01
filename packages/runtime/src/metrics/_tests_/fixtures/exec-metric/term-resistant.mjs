import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const processIdentifierPath = process.argv[2];
const markerPath = process.argv[3];
const descendantSource = `
  import { writeFileSync } from 'node:fs';
  setTimeout(() => writeFileSync(process.argv[1], 'descendant survived cleanup'), 4_000);
  setInterval(() => {}, 1_000);
`;

process.on('SIGTERM', () => {
  // The fixture deliberately requires the invoker's SIGKILL escalation.
});
writeFileSync(processIdentifierPath, String(process.pid));
spawn(process.execPath, ['--input-type=module', '--eval', descendantSource, markerPath], {
  stdio: 'ignore',
});
setInterval(() => {}, 1_000);
