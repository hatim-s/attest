import { execFile } from 'node:child_process';
import {
  access,
  cp,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { runCli } from '../run-cli.js';

type CommandExpectation = {
  argv: string[];
  artifacts_absent: string[];
  artifacts_present: string[];
  command: string;
  display: string;
  error_code?: string;
  exit_code: number;
  ok: boolean;
  result_schema?: string;
};

type Journey = {
  commands: CommandExpectation[];
  example_root: string;
  id: string;
  seed_files: Record<string, string>;
};

type Contract = {
  guide_docs: string[];
  guide_opening_headings: string[];
  index_first_screen_links: Array<{ label: string; target: string }>;
  journeys: Journey[];
  llms_required_references: string[];
  required_docs: string[];
  required_schema_references: string[];
  schema: string;
};

type CliDocument = {
  command?: string;
  error?: { code?: string };
  ok?: boolean;
  result?: { schema?: string };
  schema?: string;
};

const execFileAsync = promisify(execFile);
const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(TEST_DIRECTORY, '../../../..');
const CLI_PACKAGE_ROOT = join(REPOSITORY_ROOT, 'packages/cli');
const CONTRACT_PATH = join(TEST_DIRECTORY, 'fixtures/cli2-15-contract.json');
const temporaryDirectories: string[] = [];

/** Reads the frozen CLI2.15 acceptance matrix without coupling it to production exports. */
const readContract = async (): Promise<Contract> =>
  JSON.parse(await readFile(CONTRACT_PATH, 'utf8')) as Contract;

/** Reports every absent path together so a red canary identifies only missing task artifacts. */
const findMissingPaths = async (paths: readonly string[]): Promise<string[]> => {
  const missing: string[] = [];
  for (const path of paths) {
    try {
      await access(join(REPOSITORY_ROOT, path));
    } catch {
      missing.push(path);
    }
  }
  return missing;
};

/** Writes only test-owned seed bytes into a clean journey directory. */
const seedJourney = async (journey: Journey): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), `attest-cli2-15-${journey.id}-`));
  temporaryDirectories.push(root);
  await Promise.all(
    Object.entries(journey.seed_files).map(([path, contents]) =>
      writeFile(join(root, path), contents),
    ),
  );
  return root;
};

/** Replaces runtime-only placeholders while leaving copy-paste display commands stable. */
const materializeArgv = (argv: readonly string[]): string[] =>
  argv.map((argument) => argument.replace('$NODE', process.execPath));

/** Verifies the stable result envelope and cumulative filesystem effects for one command. */
const assertCommandResult = async (
  expectation: CommandExpectation,
  exitCode: number,
  stdout: string,
  stderr: string,
  workingDirectory: string,
): Promise<void> => {
  expect(exitCode, expectation.display).toBe(expectation.exit_code);
  expect(stderr, expectation.display).toBe('');
  const document = JSON.parse(stdout.trim()) as CliDocument;
  expect(document, expectation.display).toMatchObject({
    schema: 'attest.cli-result/v1',
    ok: expectation.ok,
    command: expectation.command,
  });
  if (expectation.error_code !== undefined) {
    expect(document.error?.code, expectation.display).toBe(expectation.error_code);
  }
  if (expectation.result_schema !== undefined) {
    expect(document.result?.schema, expectation.display).toBe(expectation.result_schema);
  }
  for (const path of expectation.artifacts_present) {
    await expect(lstat(join(workingDirectory, path)), expectation.display).resolves.toBeDefined();
  }
  for (const path of expectation.artifacts_absent) {
    await expect(lstat(join(workingDirectory, path)), expectation.display).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }
};

/** Executes the frozen command matrix through the in-process fixed-base CLI. */
const runSupportedJourney = async (journey: Journey): Promise<void> => {
  const workingDirectory = await seedJourney(journey);
  for (const command of journey.commands) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(materializeArgv(command.argv), {
      workingDirectory,
      io: {
        output: (message) => stdout.push(message),
        error: (message) => stderr.push(message),
      },
    });
    await assertCommandResult(
      command,
      exitCode,
      stdout.join('\n'),
      stderr.join('\n'),
      workingDirectory,
    );
  }
};

/** Extracts local Markdown link destinations while ignoring URLs and same-page anchors. */
const localMarkdownLinks = (markdown: string): string[] =>
  [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)]
    .map((match) => match[1]?.split('#', 1)[0] ?? '')
    .filter(
      (target) =>
        target.length > 0 &&
        !target.startsWith('#') &&
        !target.startsWith('http://') &&
        !target.startsWith('https://') &&
        !target.startsWith('mailto:'),
    );

/** Collects every versioned Attest schema discriminator published by generated artifacts. */
const generatedSchemaReferences = async (): Promise<Set<string>> => {
  const schemaDirectory = join(REPOSITORY_ROOT, 'packages/schemas/generated');
  const contract = await readContract();
  const files = await readdir(schemaDirectory);
  const publishedSchemas = (
    await Promise.all(files.map((file) => readFile(join(schemaDirectory, file), 'utf8')))
  ).join('\n');
  return new Set(
    contract.required_schema_references.filter((expected) =>
      publishedSchemas.includes(`\"${expected}\"`),
    ),
  );
};

/** Builds and extracts the CLI tarball while resolving locked workspace dependencies read-only. */
const createPackedCli = async (): Promise<string> => {
  await execFileAsync('bun', ['run', 'build'], { cwd: REPOSITORY_ROOT, timeout: 120_000 });
  const runtime = await mkdtemp(join(tmpdir(), 'attest-cli2-15-packed-'));
  temporaryDirectories.push(runtime);
  await execFileAsync('bun', ['pm', 'pack', '--destination', runtime], {
    cwd: CLI_PACKAGE_ROOT,
    timeout: 30_000,
  });
  const archives = (await readdir(runtime)).filter((path) => path.endsWith('.tgz'));
  if (archives.length !== 1 || archives[0] === undefined) {
    throw new Error(`Expected one packed CLI archive, received ${String(archives.length)}.`);
  }
  await execFileAsync('tar', ['-xzf', join(runtime, archives[0]), '-C', runtime], {
    timeout: 30_000,
  });
  // The executable bytes come from the tarball; the lockfile-installed dependencies stay read-only.
  await symlink(join(REPOSITORY_ROOT, 'node_modules'), join(runtime, 'node_modules'), 'dir');
  return join(runtime, 'package/dist/cli.js');
};

/** Runs one packed CLI command while preserving stdout and non-zero exit evidence. */
const runPackedCommand = async (
  cliPath: string,
  argv: readonly string[],
  workingDirectory: string,
): Promise<{ exitCode: number; stderr: string; stdout: string }> => {
  try {
    const result = await execFileAsync(
      process.execPath,
      ['--no-warnings', cliPath, ...materializeArgv(argv)],
      {
        cwd: workingDirectory,
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    return { exitCode: 0, stderr: result.stderr, stdout: result.stdout };
  } catch (error: unknown) {
    const failure = error as { code?: number; stderr?: string; stdout?: string };
    return {
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
      stderr: failure.stderr ?? '',
      stdout: failure.stdout ?? '',
    };
  }
};

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('CLI2.15 agent-first documentation and executable-example contract', () => {
  it('proves the fixed-base v2 runtime supports the frozen example commands', async () => {
    const contract = await readContract();
    expect(contract.schema).toBe('attest.cli2-15-acceptance/v1');
    for (const journey of contract.journeys) await runSupportedJourney(journey);
  }, 30_000);

  it('keeps the completed CLI2.14 top-level run removal intact', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(['run', '--output', 'json'], {
      io: {
        output: (message) => stdout.push(message),
        error: (message) => stderr.push(message),
      },
    });
    expect(exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join('')).toContain("unknown command 'run'");
  });

  it('publishes the complete Section 11 document tree and opening guide anatomy', async () => {
    const contract = await readContract();
    expect(await findMissingPaths(contract.required_docs)).toEqual([]);
    for (const path of contract.guide_docs) {
      const opening = (await readFile(join(REPOSITORY_ROOT, path), 'utf8'))
        .split('\n')
        .slice(0, 100)
        .join('\n');
      const headings = [...opening.matchAll(/^## .+$/gmu)].map(([heading]) => heading);
      expect(headings[0], path).toBe('## Copy-paste example');
      for (const heading of contract.guide_opening_headings) {
        expect(opening, `${path}: ${heading}`).toContain(heading);
      }
    }
  });

  it('makes first-screen journeys, local links, and published schema references resolvable', async () => {
    const contract = await readContract();
    expect(await findMissingPaths(contract.required_docs)).toEqual([]);
    const index = await readFile(join(REPOSITORY_ROOT, 'docs/index.md'), 'utf8');
    const firstScreen = index.split('\n').slice(0, 80).join('\n');
    for (const link of contract.index_first_screen_links) {
      expect(firstScreen).toContain(`[${link.label}](${link.target})`);
    }

    for (const path of contract.required_docs) {
      const markdown = await readFile(join(REPOSITORY_ROOT, path), 'utf8');
      for (const target of localMarkdownLinks(markdown)) {
        const resolved = resolve(dirname(join(REPOSITORY_ROOT, path)), target);
        await expect(access(resolved), `${path} -> ${target}`).resolves.toBeUndefined();
      }
    }
    expect(await generatedSchemaReferences()).toEqual(new Set(contract.required_schema_references));
    const schemaReference = await readFile(
      join(REPOSITORY_ROOT, 'docs/reference/schemas.md'),
      'utf8',
    );
    for (const schema of contract.required_schema_references) {
      expect(schemaReference).toContain(schema);
    }
  });

  it('publishes a compact llms.txt pointer map without forking canonical content', async () => {
    const contract = await readContract();
    expect(await findMissingPaths(['llms.txt'])).toEqual([]);
    const llms = await readFile(join(REPOSITORY_ROOT, 'llms.txt'), 'utf8');
    expect(llms.split('\n').length).toBeLessThanOrEqual(80);
    for (const reference of contract.llms_required_references) expect(llms).toContain(reference);
  });

  it('runs the checked-in example bytes and commands through the packed CLI in clean directories', async () => {
    const contract = await readContract();
    const examplePaths = contract.journeys.flatMap((journey) => [
      journey.example_root,
      `${journey.example_root}/README.md`,
      ...Object.keys(journey.seed_files).map((path) => `${journey.example_root}/${path}`),
    ]);
    expect(await findMissingPaths(examplePaths)).toEqual([]);

    const cliPath = await createPackedCli();
    for (const journey of contract.journeys) {
      const workingDirectory = await mkdtemp(
        join(tmpdir(), `attest-cli2-15-packed-${journey.id}-`),
      );
      temporaryDirectories.push(workingDirectory);
      await cp(join(REPOSITORY_ROOT, journey.example_root), workingDirectory, {
        recursive: true,
      });
      const readme = await readFile(join(workingDirectory, 'README.md'), 'utf8');
      for (const [path, contents] of Object.entries(journey.seed_files)) {
        expect(await readFile(join(workingDirectory, path), 'utf8'), path).toBe(contents);
      }
      for (const command of journey.commands) {
        expect(readme, command.display).toContain(command.display);
        const result = await runPackedCommand(cliPath, command.argv, workingDirectory);
        await assertCommandResult(
          command,
          result.exitCode,
          result.stdout,
          result.stderr,
          workingDirectory,
        );
      }
    }
  }, 180_000);
});
