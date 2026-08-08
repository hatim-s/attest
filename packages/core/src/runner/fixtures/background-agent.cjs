const http = require('node:http');

const port = Number(process.argv[2]);
const mode = process.argv[3] ?? 'normal';
const server = http.createServer((request, response) => {
  if (request.url === '/ready') {
    response.writeHead(204).end();
    return;
  }
  if (request.url === '/shutdown') {
    response.writeHead(204).end();
    server.close(() => process.exit(0));
    return;
  }
  if (request.url !== '/invoke') {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (mode === 'slow') return;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ output: envelope.input, secret: process.env.AGENT_SECRET }));
  });
});

server.listen(port, '127.0.0.1', () => {
  if (mode !== 'silent') process.stderr.write(`READY ${String(port)}\n`);
});
