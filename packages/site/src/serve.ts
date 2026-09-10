import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const built = process.argv.includes('--built');
const page = new URL(built ? '../dist/index.html' : '../index.html', import.meta.url);
// Fail at startup if preview is requested before a build exists.
readFileSync(page);

/** Serve only the landing page, keeping repository files outside the preview. */
const server = createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (pathname !== '/' && pathname !== '/index.html') {
    response.writeHead(404).end('Not found');
    return;
  }
  try {
    const html = readFileSync(page);
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(request.method === 'HEAD' ? undefined : html);
  } catch {
    response.writeHead(500).end('Could not read the landing page');
  }
});

server.listen(8735, '127.0.0.1', () => {
  console.log(`Attest site ${built ? 'preview' : 'dev'}: http://127.0.0.1:8735`);
});
