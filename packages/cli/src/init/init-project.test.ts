import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../config/load-config.js';
import { runConfiguration } from '../run/run-configuration.js';
import { initProject } from './init-project.js';

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-cli-init-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('initProject', () => {
  it('creates a quickstart whose default CLI evaluation passes', async () => {
    const parentDirectory = await createTemporaryDirectory();
    const initialized = await initProject('demo', parentDirectory);
    const loadedConfig = await loadConfig(undefined, initialized.targetDirectory);
    const result = await runConfiguration(loadedConfig);
    const tracedResult = await runConfiguration({
      ...loadedConfig,
      config: {
        ...loadedConfig.config,
        agent: { type: 'cli', command: [process.execPath, './agents/traced-agent.mjs'] },
        metrics: [],
        suites: [
          {
            name: 'traced',
            metrics: [],
            cases: [{ id: 'trace', input: { answer: 'Paris' } }],
          },
        ],
      },
    });

    expect(initialized.files).toHaveLength(5);
    expect(result.run.summary).toMatchObject({
      totalCases: 2,
      passedCases: 2,
      failedCases: 0,
      errorCases: 0,
    });
    await expect(
      readFile(join(initialized.targetDirectory, 'agents/traced-agent.mjs'), 'utf8'),
    ).resolves.toContain('attest.trace/v1alpha1');
    const tracedCase = tracedResult.cases[0];
    expect(tracedCase?.outcome).toBe('completed');
    if (tracedCase?.outcome !== 'completed') {
      throw new Error('Traced quickstart agent did not complete.');
    }
    expect(tracedCase.trace).toMatchObject({ schema: 'attest.trace/v1alpha1' });
    expect(() =>
      execFileSync(process.execPath, [
        '--check',
        join(initialized.targetDirectory, 'agents/http-agent.mjs'),
      ]),
    ).not.toThrow();
  });

  it('preflights every generated file before refusing an overwrite', async () => {
    const parentDirectory = await createTemporaryDirectory();
    const targetDirectory = join(parentDirectory, 'demo');
    const existingAgent = join(targetDirectory, 'agents/cli-agent.mjs');
    await mkdir(join(targetDirectory, 'agents'), { recursive: true });
    await writeFile(existingAgent, 'owned by user');

    await expect(initProject('demo', parentDirectory)).rejects.toMatchObject({
      code: 'init_conflict',
    });
    await expect(access(join(targetDirectory, 'attest.config.yaml'))).rejects.toBeDefined();
    await expect(readFile(existingAgent, 'utf8')).resolves.toBe('owned by user');
  });
});
