import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import * as contractsApi from '@attest/contracts';
import * as coreApi from '@attest/core';
import { afterEach, describe, expect, it } from 'vitest';

import * as cliApi from '../index.js';
import { runCli } from '../run-cli.js';

type CliInvocation = {
  errors: string[];
  exitCode: number;
  output: string[];
};

type HelpCommand = {
  alias_for: string | null;
  examples: string[];
  name: string;
  options: { flags: string; name: string }[];
  path: string[];
  subcommands: HelpCommand[];
};

type LegacySurfaceLane = {
  id: string;
  proposed_owner: string;
  shared_markers: { markers: string[]; path: string }[];
  whole_files: string[];
};

type LegacySurfaceInventory = { lanes: LegacySurfaceLane[] };

type StructuredFailure = {
  command: string;
  error: { code: string; hint?: string; message: string };
  ok: false;
};

type StructuredHelp = {
  command: string;
  ok: true;
  result: { command: HelpCommand };
};

type StructuredSchemaList = {
  command: string;
  ok: true;
  result: { items: { file: string; id: string }[] };
};

const fixtureDirectory = resolve(import.meta.dirname, 'fixtures');
const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const temporaryDirectories: string[] = [];
const breakingV2Message = 'Attest v2 does not execute v1 configuration or project inputs.';
const breakingV2Hint =
  'Create a v2 project with `attest project init`; use `attest eval run` as the only execution command.';

/** Executes one public CLI invocation while retaining the two output streams independently. */
const invokeCli = async (
  workingDirectory: string,
  argv: readonly string[],
): Promise<CliInvocation> => {
  const errors: string[] = [];
  const output: string[] = [];
  const exitCode = await runCli([...argv], {
    workingDirectory,
    io: {
      error: (message) => errors.push(message),
      output: (message) => output.push(message),
    },
  });
  return { errors, exitCode, output };
};

/** Parses the single-document structured output contract and rejects accidental extra writes. */
const parseOnlyOutput = <T>(invocation: CliInvocation): T => {
  expect(invocation.output).toHaveLength(1);
  return JSON.parse(invocation.output[0] ?? '{}') as T;
};

/** Flattens machine-readable help so command paths and alias metadata can be compared directly. */
const flattenHelp = (root: HelpCommand): HelpCommand[] => [
  root,
  ...root.subcommands.flatMap(flattenHelp),
];

/** Creates one isolated directory and materializes exactly one committed legacy input fixture. */
const createLegacyInput = async (fileName: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-v1-removal-contract-'));
  temporaryDirectories.push(directory);
  await writeFile(
    join(directory, fileName),
    await readFile(join(fixtureDirectory, fileName), 'utf8'),
  );
  return directory;
};

/** Reads the committed removal inventory without coupling the test to generated module imports. */
const readInventory = async (): Promise<LegacySurfaceInventory> =>
  JSON.parse(
    await readFile(join(fixtureDirectory, 'v1-production-surfaces.json'), 'utf8'),
  ) as LegacySurfaceInventory;

/** Reads a production source when present and returns undefined once a whole-file surface is gone. */
const readOptionalProductionFile = async (relativePath: string): Promise<string | undefined> => {
  try {
    return await readFile(resolve(repositoryRoot, relativePath), 'utf8');
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('CLI2.14 v1 removal negative contract', () => {
  it('exposes eval run as the only execution path and init as the only alias', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'attest-v1-help-contract-'));
    temporaryDirectories.push(directory);
    const jsonHelp = await invokeCli(directory, ['help', '--output', 'json']);
    expect(jsonHelp).toMatchObject({ exitCode: 0, errors: [] });
    const help = parseOnlyOutput<StructuredHelp>(jsonHelp);
    const commands = flattenHelp(help.result.command);

    expect(commands.filter(({ name }) => name === 'run').map(({ path }) => path.join('.'))).toEqual(
      ['eval.run'],
    );
    expect(
      commands
        .filter(({ alias_for: aliasFor }) => aliasFor !== null)
        .map(({ alias_for: aliasFor, path }) => ({ aliasFor, path: path.join('.') })),
    ).toEqual([{ aliasFor: 'project.init', path: 'init' }]);

    const serializedHelp = JSON.stringify(help.result);
    expect(serializedHelp).not.toContain('attest run');
    expect(serializedHelp).not.toContain('attest.config');
    expect(serializedHelp).not.toContain('config.v1.json');

    const humanHelp = await invokeCli(directory, ['--help']);
    expect(humanHelp.exitCode).toBe(0);
    expect(humanHelp.errors).toEqual([]);
    expect(humanHelp.output.join('')).not.toMatch(/^\s*run(?:\s|$)/mu);
  });

  it('rejects the removed top-level run command before any project execution', async () => {
    const directory = await createLegacyInput('attest.config.json');
    const invocation = await invokeCli(directory, ['run']);

    expect(invocation.exitCode).toBe(2);
    expect(invocation.output).toEqual([]);
    expect(invocation.errors.join('')).toContain("unknown command 'run'");
    await expect(access(join(directory, '.attest'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['attest.config.json', 'attest.config.yaml', 'attest.config.yml'])(
    'rejects %s with stable breaking-v2 guidance',
    async (fileName) => {
      const directory = await createLegacyInput(fileName);
      const invocation = await invokeCli(directory, ['eval', 'run', '--all', '--output', 'json']);

      expect(invocation).toMatchObject({ exitCode: 1, errors: [] });
      expect(parseOnlyOutput<StructuredFailure>(invocation)).toMatchObject({
        ok: false,
        command: 'eval.run',
        error: {
          code: 'project_not_found',
          message: breakingV2Message,
          hint: breakingV2Hint,
        },
      });
      await expect(access(join(directory, '.attest'))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('rejects a v1-shaped project manifest with the same stable breaking-v2 guidance', async () => {
    const directory = await createLegacyInput('attest.project.json');
    const invocation = await invokeCli(directory, ['eval', 'run', '--all', '--output', 'json']);

    expect(invocation).toMatchObject({ exitCode: 1, errors: [] });
    expect(parseOnlyOutput<StructuredFailure>(invocation)).toMatchObject({
      ok: false,
      command: 'eval.run',
      error: {
        code: 'project_invalid',
        message: breakingV2Message,
        hint: breakingV2Hint,
      },
    });
    await expect(access(join(directory, '.attest'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not offer a project-level v1 importer fallback', async () => {
    const directory = await createLegacyInput('attest.config.json');
    const invocation = await invokeCli(directory, ['project', 'import', 'attest.config.json']);

    expect(invocation.exitCode).toBe(2);
    expect(invocation.output).toEqual([]);
    expect(invocation.errors.join('')).toContain("unknown command 'import'");
    await expect(access(join(directory, '.attest'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('excludes the v1 config contract from JSON schema discovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'attest-v1-schema-contract-'));
    temporaryDirectories.push(directory);
    const invocation = await invokeCli(directory, ['schema', 'list', '--output', 'json']);

    expect(invocation).toMatchObject({ exitCode: 0, errors: [] });
    const schemaList = parseOnlyOutput<StructuredSchemaList>(invocation);
    expect(schemaList.result.items.map(({ file }) => file)).not.toContain('config.v1.json');
  });

  it('removes legacy config and execution APIs from public package discovery', () => {
    expect(Object.keys(cliApi)).not.toEqual(expect.arrayContaining(['runLegacyConfiguration']));
    expect(Object.keys(coreApi)).not.toEqual(
      expect.arrayContaining(['collectExecutions', 'executeCases', 'loadDatasetCases']),
    );
    expect(Object.keys(contractsApi)).not.toEqual(
      expect.arrayContaining(['configSchema', 'parseConfig']),
    );
  });

  it('removes every inventoried v1 production surface within its proposed ownership lane', async () => {
    const inventory = await readInventory();
    const remaining: { lane: string; owner: string; surface: string }[] = [];

    for (const lane of inventory.lanes) {
      for (const relativePath of lane.whole_files) {
        if ((await readOptionalProductionFile(relativePath)) !== undefined) {
          remaining.push({ lane: lane.id, owner: lane.proposed_owner, surface: relativePath });
        }
      }
      for (const { markers, path } of lane.shared_markers) {
        const source = await readOptionalProductionFile(path);
        if (source === undefined) continue;
        for (const marker of markers) {
          if (source.includes(marker)) {
            remaining.push({
              lane: lane.id,
              owner: lane.proposed_owner,
              surface: `${path} :: ${marker}`,
            });
          }
        }
      }
    }

    expect(remaining).toEqual([]);
  });
});
