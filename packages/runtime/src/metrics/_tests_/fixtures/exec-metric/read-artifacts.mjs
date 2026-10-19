import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Passes only when both artifacts are on disk with the bytes the request carries inline.
const chunks = [];

process.stdin.on('data', (chunk) => chunks.push(chunk));

process.stdin.on('end', () => {
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const text = readFileSync(join(request.artifact_dir, 'notes/a.txt'), 'utf8');
  const bytes = readFileSync(join(request.artifact_dir, 'b.bin'));
  const pass = text === 'hello file' && bytes.equals(Buffer.from([0xff, 0x00, 0x01]));

  process.stdout.write(
    JSON.stringify({ score: pass ? 1 : 0, pass, details: { artifact_dir: request.artifact_dir } }),
  );
});
