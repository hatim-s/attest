import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { runCli } from '../../run-cli.js';

type CommandExpectation = {
  argv: string[];
  artifact_documents: Record<string, Record<string, unknown>>;
  artifacts_absent: string[];
  artifacts_present: string[];
  command: string;
  display: string;
  error_code?: string;
  exit_code: number;
  ok: boolean;
  result_schema?: string;
  tree_changes: string[];
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

type TreeEntry =
  { kind: 'directory' } | { kind: 'file'; sha256: string } | { kind: 'symlink'; target: string };

type TreeSnapshot = Map<string, TreeEntry>;

type PackedCliRuntime = {
  archivePaths: Record<string, string>;
  cliPath: string;
  root: string;
};

const execFileAsync = promisify(execFile);
const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(TEST_DIRECTORY, '../../../../..');
const CONTRACT_PATH = join(TEST_DIRECTORY, 'fixtures/documentation-contract.json');
const PACKED_PACKAGE_ROOTS = [
  'packages/contracts',
  'packages/core',
  'packages/web',
  'packages/cli',
] as const;
const PACKED_PACKAGE_NAMES = [
  '@attest/cli',
  '@attest/contracts',
  '@attest/core',
  '@attest/web',
] as const;
const temporaryDirectories: string[] = [];
let packedCliRuntimePromise: Promise<PackedCliRuntime> | undefined;

/** Reads the frozen acceptance matrix without coupling it to production exports. */
const readContract = async (): Promise<Contract> =>
  JSON.parse(await readFile(CONTRACT_PATH, 'utf8')) as Contract;

/** Reports whether a candidate path is the owned root or one of its descendants. */
const isPathContained = (ownedRoot: string, candidate: string): boolean => {
  const relativePath = relative(ownedRoot, candidate);
  return (
    relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
};

/** Rejects an existing target or nearest existing ancestor that resolves outside the owned root. */
const assertRealPathContained = async (
  ownedRoot: string,
  candidate: string,
  label: string,
): Promise<void> => {
  const realOwnedRoot = await realpath(ownedRoot);
  let probe = candidate;
  while (true) {
    try {
      const realProbe = await realpath(probe);
      if (!isPathContained(realOwnedRoot, realProbe)) {
        throw new Error(`${label} resolves outside its owned root.`);
      }
      return;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(probe);
      if (parent === probe) throw error;
      probe = parent;
    }
  }
};

/** Resolves one untrusted contract path below an owned root and rejects ambiguous path syntax. */
const resolveOwnedPath = async (
  ownedRoot: string,
  baseDirectory: string,
  contractPath: string,
  label: string,
): Promise<string> => {
  if (
    contractPath.trim().length === 0 ||
    contractPath.includes('\0') ||
    contractPath.includes('\\') ||
    contractPath.startsWith('file:') ||
    isAbsolute(contractPath) ||
    /^[A-Za-z]:[\\/]/u.test(contractPath)
  ) {
    throw new Error(`${label} is not a safe relative path.`);
  }
  const candidate = resolve(baseDirectory, contractPath);
  if (candidate === resolve(ownedRoot) || !isPathContained(resolve(ownedRoot), candidate)) {
    throw new Error(`${label} escapes its owned root.`);
  }
  await assertRealPathContained(ownedRoot, candidate, label);
  return candidate;
};

/** Resolves a local Markdown target while allowing doc-relative movement only inside the repository. */
const resolveMarkdownTarget = async (documentPath: string, target: string): Promise<string> =>
  resolveOwnedPath(
    REPOSITORY_ROOT,
    dirname(documentPath),
    target,
    `${relative(REPOSITORY_ROOT, documentPath)} -> ${target}`,
  );

/** Reports every absent path together so a red canary identifies only missing task artifacts. */
const findMissingPaths = async (paths: readonly string[]): Promise<string[]> => {
  const missing: string[] = [];
  for (const path of paths) {
    try {
      const resolvedPath = await resolveOwnedPath(
        REPOSITORY_ROOT,
        REPOSITORY_ROOT,
        path,
        `required path ${path}`,
      );
      await access(resolvedPath);
    } catch {
      missing.push(path);
    }
  }
  return missing;
};

/** Writes only test-owned seed bytes into a clean journey directory. */
const seedJourney = async (journey: Journey): Promise<string> => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(journey.id)) {
    throw new Error(`Journey id ${journey.id} is not a safe slug.`);
  }
  const root = await mkdtemp(join(tmpdir(), `attest-documentation-${journey.id}-`));
  temporaryDirectories.push(root);
  for (const [path, contents] of Object.entries(journey.seed_files)) {
    const destination = await resolveOwnedPath(root, root, path, `seed file ${path}`);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  return root;
};

/** Captures every directory, symlink target, and file byte hash below a journey root. */
const snapshotTree = async (root: string): Promise<TreeSnapshot> => {
  const snapshot: TreeSnapshot = new Map();
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(root, absolutePath).split(sep).join('/');
      await assertRealPathContained(root, absolutePath, `tree entry ${relativePath}`);
      if (entry.isSymbolicLink()) {
        snapshot.set(relativePath, { kind: 'symlink', target: await readlink(absolutePath) });
      } else if (entry.isDirectory()) {
        snapshot.set(`${relativePath}/`, { kind: 'directory' });
        await visit(absolutePath);
      } else if (entry.isFile()) {
        const sha256 = createHash('sha256')
          .update(await readFile(absolutePath))
          .digest('hex');
        snapshot.set(relativePath, { kind: 'file', sha256 });
      } else {
        throw new Error(`Unsupported tree entry type at ${relativePath}.`);
      }
    }
  };
  await visit(root);
  return snapshot;
};

/** Returns every path whose type, link target, or file bytes changed between two snapshots. */
const changedTreePaths = (before: TreeSnapshot, after: TreeSnapshot): string[] => {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .filter((path) => JSON.stringify(before.get(path)) !== JSON.stringify(after.get(path)))
    .sort();
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
  treeBefore: TreeSnapshot,
): Promise<void> => {
  expect(exitCode, expectation.display).toBe(expectation.exit_code);
  expect(stderr, expectation.display).toBe('');
  const document = JSON.parse(stdout.trim()) as CliDocument;
  expect(document, expectation.display).toMatchObject({
    schema: 'attest.cli-result',
    ok: expectation.ok,
    command: expectation.command,
  });
  if (expectation.error_code !== undefined) {
    expect(document.error?.code, expectation.display).toBe(expectation.error_code);
  }
  if (expectation.result_schema !== undefined) {
    expect(document.result?.schema, expectation.display).toBe(expectation.result_schema);
  }
  const treeAfter = await snapshotTree(workingDirectory);
  expect(changedTreePaths(treeBefore, treeAfter), expectation.display).toEqual(
    [...expectation.tree_changes].sort(),
  );
  for (const path of expectation.artifacts_present) {
    const artifactPath = await resolveOwnedPath(
      workingDirectory,
      workingDirectory,
      path,
      `present artifact ${path}`,
    );
    await expect(lstat(artifactPath), expectation.display).resolves.toBeDefined();
  }
  for (const path of expectation.artifacts_absent) {
    const artifactPath = await resolveOwnedPath(
      workingDirectory,
      workingDirectory,
      path,
      `absent artifact ${path}`,
    );
    await expect(lstat(artifactPath), expectation.display).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }
  for (const [path, expectedDocument] of Object.entries(expectation.artifact_documents)) {
    const artifactPath = await resolveOwnedPath(
      workingDirectory,
      workingDirectory,
      path,
      `artifact document ${path}`,
    );
    const artifactDocument = JSON.parse(await readFile(artifactPath, 'utf8')) as unknown;
    expect(artifactDocument, `${expectation.display}: ${path}`).toMatchObject(expectedDocument);
  }
};

/** Executes the frozen command matrix through the in-process fixed-base CLI. */
const runSupportedJourney = async (journey: Journey): Promise<void> => {
  const workingDirectory = await seedJourney(journey);
  for (const command of journey.commands) {
    const treeBefore = await snapshotTree(workingDirectory);
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
      treeBefore,
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

/** Collects every Attest schema identifier published by generated artifacts. */
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

/** Packs every runtime workspace and installs the CLI into a dependency-clean production prefix. */
const createPackedCli = async (): Promise<PackedCliRuntime> => {
  await execFileAsync('bun', ['run', 'build'], { cwd: REPOSITORY_ROOT, timeout: 120_000 });
  const runtime = await mkdtemp(join(tmpdir(), 'attest-documentation-packed-'));
  temporaryDirectories.push(runtime);
  const archiveDirectory = join(runtime, 'archives');
  await mkdir(archiveDirectory);
  const archivePaths: Record<string, string> = {};
  for (const packageRoot of PACKED_PACKAGE_ROOTS) {
    const { stdout } = await execFileAsync(
      'bun',
      ['pm', 'pack', '--quiet', '--destination', archiveDirectory],
      {
        cwd: join(REPOSITORY_ROOT, packageRoot),
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    const reportedArchive = stdout.trim();
    const archivePath = await resolveOwnedPath(
      runtime,
      runtime,
      relative(runtime, reportedArchive),
      `packed archive ${reportedArchive}`,
    );
    const { stdout: manifestJson } = await execFileAsync(
      'tar',
      ['-xOf', archivePath, 'package/package.json'],
      { encoding: 'utf8', timeout: 30_000 },
    );
    const manifest = JSON.parse(manifestJson) as { name?: string };
    const packageName = manifest.name as (typeof PACKED_PACKAGE_NAMES)[number] | undefined;
    if (packageName === undefined || !PACKED_PACKAGE_NAMES.includes(packageName)) {
      throw new Error(`Packed archive has unexpected package name ${String(manifest.name)}.`);
    }
    archivePaths[packageName] = archivePath;
  }
  if (Object.keys(archivePaths).sort().join('\n') !== [...PACKED_PACKAGE_NAMES].sort().join('\n')) {
    throw new Error('Packed runtime workspace set is incomplete.');
  }

  const archiveReference = (packageName: (typeof PACKED_PACKAGE_NAMES)[number]): string =>
    `./archives/${basename(archivePaths[packageName] ?? '')}`;
  const installManifest = {
    private: true,
    dependencies: { '@attest/cli': archiveReference('@attest/cli') },
    overrides: {
      '@attest/contracts': archiveReference('@attest/contracts'),
      '@attest/core': archiveReference('@attest/core'),
      '@attest/web': archiveReference('@attest/web'),
    },
  };
  await writeFile(join(runtime, 'package.json'), `${JSON.stringify(installManifest, null, 2)}\n`);
  await execFileAsync(
    'bun',
    [
      'install',
      '--production',
      '--ignore-scripts',
      '--no-save',
      // Ambient isolated/global-store settings must not link outside this owned runtime.
      '--linker',
      'hoisted',
      // The frozen repository install primes Bun's cache; offline mode forbids registry access.
      '--offline',
    ],
    { cwd: runtime, timeout: 120_000 },
  );

  const cliPath = join(runtime, 'node_modules/.bin/attest');
  await access(cliPath, constants.X_OK);
  return { archivePaths, cliPath, root: runtime };
};

/** Reuses one immutable packed installation across its layout and executable-journey assertions. */
const getPackedCli = (): Promise<PackedCliRuntime> => {
  packedCliRuntimePromise ??= createPackedCli();
  return packedCliRuntimePromise;
};

/** Runs one installed CLI entrypoint under Node while preserving stdout and non-zero exit evidence. */
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
        maxBuffer: 10 * 1024 * 1024,
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

describe('agent-first documentation and executable-example contract', () => {
  it('proves the runtime supports the frozen example commands', async () => {
    const contract = await readContract();
    expect(contract.schema).toBe('attest.acceptance.documentation');
    for (const journey of contract.journeys) await runSupportedJourney(journey);
  }, 30_000);

  it('keeps the completed top-level run removal intact', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(['run', '--output', 'json'], {
      io: {
        output: (message) => stdout.push(message),
        error: (message) => stderr.push(message),
      },
    });
    expect(exitCode).toBe(2);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toMatchObject({
      schema: 'attest.cli-result',
      ok: false,
      command: 'run',
      error: { code: 'cli_usage', message: "error: unknown command 'run'" },
    });
  });

  it('detects changed artifact bytes and unexpected no-write residue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attest-documentation-tree-hostile-'));
    temporaryDirectories.push(root);
    await writeFile(join(root, 'attest.project.json'), '{"schema":"attest.project"}\n');
    const before = await snapshotTree(root);
    await writeFile(join(root, 'attest.project.json'), '{"schema":"corrupted"}\n');
    await writeFile(join(root, '.attest.lock'), 'unexpected residue\n');
    const after = await snapshotTree(root);
    expect(changedTreePaths(before, after)).toEqual(['.attest.lock', 'attest.project.json']);
  });

  it('rejects fixture traversal, absolute paths, and symlink escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attest-documentation-path-hostile-'));
    const outside = await mkdtemp(join(tmpdir(), 'attest-documentation-path-outside-'));
    temporaryDirectories.push(root, outside);
    await symlink(outside, join(root, 'escape'), 'dir');
    await expect(
      resolveOwnedPath(root, root, '../outside.json', 'traversal fixture'),
    ).rejects.toThrow(/escapes its owned root/u);
    await expect(resolveOwnedPath(root, root, '/etc/passwd', 'absolute fixture')).rejects.toThrow(
      /safe relative path/u,
    );
    await expect(
      resolveOwnedPath(root, root, 'escape/outside.json', 'symlink fixture'),
    ).rejects.toThrow(/resolves outside its owned root/u);
    await expect(
      resolveOwnedPath(root, root, 'nested/inside.json', 'contained fixture'),
    ).resolves.toBe(join(root, 'nested/inside.json'));
  });

  it('rejects repository-external and file-URL Markdown targets', async () => {
    const documentPath = join(REPOSITORY_ROOT, 'docs/index.md');
    await expect(resolveMarkdownTarget(documentPath, './cli/agents.md')).resolves.toBe(
      join(REPOSITORY_ROOT, 'docs/cli/agents.md'),
    );
    await expect(
      resolveMarkdownTarget(documentPath, '../../../../../../etc/passwd'),
    ).rejects.toThrow(/escapes its owned root/u);
    await expect(resolveMarkdownTarget(documentPath, '/etc/passwd')).rejects.toThrow(
      /safe relative path/u,
    );
    await expect(resolveMarkdownTarget(documentPath, 'file:///etc/passwd')).rejects.toThrow(
      /safe relative path/u,
    );
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
      const documentPath = await resolveOwnedPath(
        REPOSITORY_ROOT,
        REPOSITORY_ROOT,
        path,
        `required document ${path}`,
      );
      const markdown = await readFile(documentPath, 'utf8');
      for (const target of localMarkdownLinks(markdown)) {
        const resolved = await resolveMarkdownTarget(documentPath, target);
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

  it('installs packed workspace dependencies without ambient repository links', async () => {
    const packed = await getPackedCli();
    const realRuntime = await realpath(packed.root);
    const realRepository = await realpath(REPOSITORY_ROOT);
    const nodeModules = await lstat(join(packed.root, 'node_modules'));
    expect(nodeModules.isDirectory()).toBe(true);
    expect(nodeModules.isSymbolicLink()).toBe(false);
    expect(Object.keys(packed.archivePaths).sort()).toEqual([...PACKED_PACKAGE_NAMES].sort());
    for (const packageName of PACKED_PACKAGE_NAMES) {
      const packageRoot = await realpath(join(packed.root, 'node_modules', packageName));
      expect(isPathContained(realRuntime, packageRoot), packageName).toBe(true);
      expect(isPathContained(realRepository, packageRoot), packageName).toBe(false);
    }
    const realCliPath = await realpath(packed.cliPath);
    expect(isPathContained(realRuntime, realCliPath)).toBe(true);
    expect(isPathContained(realRepository, realCliPath)).toBe(false);
    const result = await runPackedCommand(
      packed.cliPath,
      ['help', 'agent', 'add', '--output', 'json'],
      packed.root,
    );
    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout) as CliDocument).toMatchObject({
      schema: 'attest.cli-result',
      ok: true,
      command: 'help',
    });
  }, 180_000);

  it('runs the checked-in example bytes and commands through the packed CLI in clean directories', async () => {
    const contract = await readContract();
    const examplePaths = contract.journeys.flatMap((journey) => [
      journey.example_root,
      `${journey.example_root}/README.md`,
      ...Object.keys(journey.seed_files).map((path) => `${journey.example_root}/${path}`),
    ]);
    expect(await findMissingPaths(examplePaths)).toEqual([]);

    const packed = await getPackedCli();
    for (const journey of contract.journeys) {
      const workingDirectory = await mkdtemp(
        join(tmpdir(), `attest-documentation-packed-${journey.id}-`),
      );
      temporaryDirectories.push(workingDirectory);
      const exampleRoot = await resolveOwnedPath(
        REPOSITORY_ROOT,
        REPOSITORY_ROOT,
        journey.example_root,
        `example root ${journey.example_root}`,
      );
      await snapshotTree(exampleRoot);
      await cp(exampleRoot, workingDirectory, {
        recursive: true,
      });
      const readmePath = await resolveOwnedPath(
        workingDirectory,
        workingDirectory,
        'README.md',
        `${journey.id} README`,
      );
      const readme = await readFile(readmePath, 'utf8');
      for (const [path, contents] of Object.entries(journey.seed_files)) {
        const seedPath = await resolveOwnedPath(
          workingDirectory,
          workingDirectory,
          path,
          `${journey.id} seed ${path}`,
        );
        expect(await readFile(seedPath, 'utf8'), path).toBe(contents);
      }
      for (const command of journey.commands) {
        const treeBefore = await snapshotTree(workingDirectory);
        expect(readme, command.display).toContain(command.display);
        const result = await runPackedCommand(packed.cliPath, command.argv, workingDirectory);
        await assertCommandResult(
          command,
          result.exitCode,
          result.stdout,
          result.stderr,
          workingDirectory,
          treeBefore,
        );
      }
    }
  }, 180_000);
});
