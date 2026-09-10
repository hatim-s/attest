import { copyFile, mkdir } from 'node:fs/promises';

// Copy without transforming the approved HTML, styles, or animation scripts.
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await copyFile(
  new URL('../index.html', import.meta.url),
  new URL('../dist/index.html', import.meta.url),
);
console.log('Built packages/site/dist/index.html');
