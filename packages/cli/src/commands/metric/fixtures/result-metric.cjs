let request = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  request += chunk;
});
process.stdin.on('end', () => {
  JSON.parse(request);
  const mode = process.argv[2] ?? 'pass';
  const result = {
    score: 1,
    pass: true,
    ...(mode === 'redact' ? { rationale: process.env.METRIC_SECRET } : {}),
    details: { argv: process.argv.slice(3), cwd: process.cwd() },
  };
  process.stdout.write(JSON.stringify(result));
});
