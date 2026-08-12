import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const processIdentifierPath = process.argv[2];
const markerPath = process.argv[3];
// Configurable so tests can keep the marker delay safely beyond the kill window
// regardless of machine load; a surviving descendant must still be catchable.
const markerDelayMs = Number(process.argv[4] ?? 250);
const descendantSource = `
  import { writeFileSync } from 'node:fs';
  setTimeout(() => writeFileSync(process.argv[1], 'detached descendant exited'), ${markerDelayMs});
`;

writeFileSync(processIdentifierPath, String(process.pid));
const descendant = spawn(
  process.execPath,
  ['--input-type=module', '--eval', descendantSource, markerPath],
  { detached: true, stdio: 'ignore' },
);
descendant.unref();
setInterval(() => {}, 1_000);
