let request = '';

process.stdin.setEncoding('utf8');

process.stdin.on('data', (chunk) => {
  request += chunk;
});

process.stdin.on('end', () => {
  JSON.parse(request);
  const mode = process.argv[2] ?? 'pass';

  const details = { argv: process.argv.slice(3), cwd: process.cwd() };

  if (mode === 'ambient' || mode === 'redact') details.env_keys = Object.keys(process.env).sort();
  const result = { score: 1, pass: true, details };

  if (mode === 'redact') result.rationale = process.env.METRIC_SECRET;

  if (mode === 'ambient')
    result.rationale = process.env.ATTEST_METRIC_AMBIENT_SECRET ?? 'ambient-absent';

  process.stdout.write(JSON.stringify(result));
});
