import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AttestCliError } from '../errors.js';
import { discoverConfigPath, loadConfig } from './load-config.js';

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-cli-config-'));
  temporaryDirectories.push(directory);
  return directory;
};

const jsonConfig = {
  config_version: 1,
  agent: { type: 'cli', command: ['/usr/bin/true'] },
  suites: [{ name: 'smoke', metrics: [], cases: [{ id: 'one', input: 'hello' }] }],
  metrics: [],
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('loadConfig', () => {
  it('gives YAML precedence and canonicalizes it identically to JSON', async () => {
    const directory = await createTemporaryDirectory();
    const yamlPath = join(directory, 'attest.config.yaml');
    const jsonPath = join(directory, 'alternate.json');
    await writeFile(
      yamlPath,
      [
        'config_version: 1',
        'agent:',
        '  type: cli',
        '  command: [/usr/bin/true]',
        'suites:',
        '  - name: smoke',
        '    metrics: []',
        '    cases:',
        '      - id: one',
        '        input: hello',
        'metrics: []',
        '',
      ].join('\n'),
    );
    await writeFile(jsonPath, JSON.stringify(jsonConfig));

    const discovered = await loadConfig(undefined, directory);
    const explicitJson = await loadConfig(jsonPath, directory);

    expect(await discoverConfigPath(directory)).toBe(yamlPath);
    expect(discovered.canonicalJson).toBe(explicitJson.canonicalJson);
    expect(discovered.configHash).toBe(explicitJson.configHash);
  });

  it('reports all contract issues before execution', async () => {
    const directory = await createTemporaryDirectory();
    const configPath = join(directory, 'attest.config.json');
    await writeFile(configPath, JSON.stringify({ ...jsonConfig, unknown: true, suites: [] }));

    await expect(loadConfig(configPath, directory)).rejects.toMatchObject({
      code: 'config_invalid',
    } satisfies Partial<AttestCliError>);
  });

  it('fails with an actionable discovery error when no config exists', async () => {
    const directory = await createTemporaryDirectory();

    await expect(loadConfig(undefined, directory)).rejects.toThrow(
      /Expected attest\.config\.yaml, attest\.config\.yml, attest\.config\.json/,
    );
  });
});
