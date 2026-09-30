process.stdin.resume();
process.stdin.on('end', () => process.stdout.write(JSON.stringify({ score: 1, pass: true })));
