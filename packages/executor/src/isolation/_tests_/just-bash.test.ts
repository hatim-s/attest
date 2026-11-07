import { run } from '../../_tests_/support/run-effect.js';
import { describe, expect, it } from 'vitest';

import { justBashIsolation } from '../just-bash.js';
import { caseContext } from './support/case-context.js';

describe('just-bash case isolation', () => {
  it('uses workspace-relative paths for seeds and file operations', async () => {
    const environment = await run(
      justBashIsolation({
        files: { './inputs/../input.txt': 'seed' },
      })(caseContext()),
    );

    try {
      await expect(run(environment.readFile('input.txt'))).resolves.toBe('seed');
      await run(environment.writeFile('results/../result.txt', 'done'));
      await expect(run(environment.readFile('./result.txt'))).resolves.toBe('done');
      await expect(run(environment.readFile('/workspace/input.txt'))).rejects.toThrow(
        /relative path/u,
      );
      await expect(run(environment.writeFile('../outside.txt', 'no'))).rejects.toThrow(
        /workspace/u,
      );
    } finally {
      await run(environment.dispose());
    }

    await expect(
      run(justBashIsolation({ files: { '../outside.txt': 'no' } })(caseContext())),
    ).rejects.toThrow(/workspace/u);
  });

  it('serializes commands inside one environment', async () => {
    const environment = await run(justBashIsolation()(caseContext()));

    try {
      const first = run(environment.exec('sleep 0.02; echo first >> order.txt'));
      const second = run(environment.exec('echo second >> order.txt'));
      await Promise.all([first, second]);

      await expect(run(environment.readFile('order.txt'))).resolves.toBe('first\nsecond\n');
    } finally {
      await run(environment.dispose());
    }
  });

  it('drains run work and permits bounded final reads after run cancellation', async () => {
    const controller = new AbortController();

    const environment = await run(
      justBashIsolation({ files: { 'partial.txt': 'partial' } })(caseContext(controller.signal)),
    );

    const pending = run(environment.exec('sleep 10; echo late > late.txt'));
    controller.abort(new Error('run cancelled'));

    await run(environment.beginFinalization());
    await expect(pending).rejects.toThrow();
    await expect(run(environment.readFile('partial.txt'))).resolves.toBe('partial');
    await run(environment.writeFile('final.txt', 'recovered'));
    await expect(run(environment.readFile('final.txt'))).resolves.toBe('recovered');

    await run(environment.dispose());
    await expect(run(environment.readFile('partial.txt'))).rejects.toThrow(/disposed/u);
  });

  it('expires the separate finalization lifetime', async () => {
    const environment = await run(justBashIsolation({ finalizationTimeoutMs: 5 })(caseContext()));
    await run(environment.beginFinalization());
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(run(environment.readFile('missing.txt'))).rejects.toThrow();
    await run(environment.dispose());
  });
});
