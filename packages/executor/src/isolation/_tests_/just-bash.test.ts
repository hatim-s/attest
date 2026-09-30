import { describe, expect, it } from 'vitest';

import { justBashIsolation } from '../just-bash.js';

const context = (signal = new AbortController().signal) => ({
  runId: 'run',
  testId: 'test',
  caseId: 'case',
  configuredIndex: 0,
  workerIndex: 0,
  signal,
});

describe('just-bash case isolation', () => {
  it('uses workspace-relative paths for seeds and file operations', async () => {
    const environment = await justBashIsolation({
      files: { './inputs/../input.txt': 'seed' },
    })(context());

    try {
      await expect(environment.readFile('input.txt')).resolves.toBe('seed');
      await environment.writeFile('results/../result.txt', 'done');
      await expect(environment.readFile('./result.txt')).resolves.toBe('done');
      await expect(environment.readFile('/workspace/input.txt')).rejects.toThrow(/relative path/u);
      await expect(environment.writeFile('../outside.txt', 'no')).rejects.toThrow(/workspace/u);
    } finally {
      await environment.dispose();
    }

    await expect(
      justBashIsolation({ files: { '../outside.txt': 'no' } })(context()),
    ).rejects.toThrow(/workspace/u);
  });

  it('serializes commands inside one environment', async () => {
    const environment = await justBashIsolation()(context());

    try {
      const first = environment.exec('sleep 0.02; echo first >> order.txt');
      const second = environment.exec('echo second >> order.txt');
      await Promise.all([first, second]);

      await expect(environment.readFile('order.txt')).resolves.toBe('first\nsecond\n');
    } finally {
      await environment.dispose();
    }
  });

  it('drains run work and permits bounded final reads after run cancellation', async () => {
    const controller = new AbortController();
    const environment = await justBashIsolation({ files: { 'partial.txt': 'partial' } })(
      context(controller.signal),
    );
    const pending = environment.exec('sleep 10; echo late > late.txt');
    controller.abort(new Error('run cancelled'));

    await environment.beginFinalization();
    await expect(pending).rejects.toThrow();
    await expect(environment.readFile('partial.txt')).resolves.toBe('partial');
    await environment.writeFile('final.txt', 'recovered');
    await expect(environment.readFile('final.txt')).resolves.toBe('recovered');

    await environment.dispose();
    expect(() => environment.readFile('partial.txt')).toThrow(/disposed/u);
  });

  it('expires the separate finalization lifetime', async () => {
    const environment = await justBashIsolation({ finalizationTimeoutMs: 5 })(context());
    await environment.beginFinalization();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(() => environment.readFile('missing.txt')).toThrow();
    await environment.dispose();
  });
});
