import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const releaseDirectory = resolve(root, 'dist/release');
const packageNames = ['contracts', 'core', 'web', 'cli', 'schemas'];

type Manifest = {
  name: string;
  version: string;
  private?: boolean;
  files: string[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};

/** Packs only built artifacts, rewriting workspace references to the exact release version. */
const packRelease = async (): Promise<void> => {
  const manifests = await Promise.all(
    packageNames.map(async (name) => {
      const manifest = JSON.parse(
        await readFile(resolve(root, 'packages', name, 'package.json'), 'utf8'),
      ) as Manifest;
      return { directory: name, manifest };
    }),
  );
  const versions = new Set(manifests.map(({ manifest }) => manifest.version));
  if (versions.size !== 1 || !/^\d+\.\d+\.\d+-alpha\.\d+$/.test(manifests[0]!.manifest.version)) {
    throw new Error('All release packages must use the same x.y.z-alpha.n version.');
  }
  const byName = new Map(manifests.map(({ manifest }) => [manifest.name, manifest]));
  const staging = await mkdtemp(join(tmpdir(), 'attest-pack-'));
  await rm(releaseDirectory, { force: true, recursive: true });
  await mkdir(releaseDirectory, { recursive: true });
  try {
    const checksums: string[] = [];
    for (const { directory, manifest } of manifests) {
      if (manifest.private) throw new Error(`${manifest.name} is private.`);
      const staged = join(staging, directory);
      const source = resolve(root, 'packages', directory);
      await mkdir(staged);
      for (const entry of manifest.files.filter((file) => !['LICENSE', 'NOTICE'].includes(file))) {
        await cp(join(source, entry), join(staged, entry), {
          recursive: true,
          filter: (path) => !/(^|\/)_tests_?(\/|$)/.test(path) && !path.endsWith('.tsbuildinfo'),
        });
      }
      await cp(resolve(root, 'LICENSE'), join(staged, 'LICENSE'));
      await cp(resolve(root, 'NOTICE'), join(staged, 'NOTICE'));
      try {
        await cp(join(source, 'README.md'), join(staged, 'README.md'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await cp(resolve(root, 'README.md'), join(staged, 'README.md'));
      }
      for (const dependencies of [manifest.dependencies, manifest.optionalDependencies]) {
        for (const [name, version] of Object.entries(dependencies ?? {})) {
          if (version.startsWith('workspace:')) {
            const dependency = byName.get(name);
            if (!dependency || dependency.private)
              throw new Error(`Unpublishable dependency ${name}.`);
            dependencies![name] = dependency.version;
          }
        }
      }
      // Consumers receive compiled code and never need the monorepo build toolchain.
      delete manifest.scripts;
      delete manifest.devDependencies;
      await writeFile(join(staged, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      const packed = JSON.parse(
        execFileSync(
          'npm',
          ['pack', '--json', '--ignore-scripts', '--pack-destination', releaseDirectory],
          {
            cwd: staged,
            encoding: 'utf8',
          },
        ),
      ) as { filename: string; files: { path: string }[] }[];
      const result = packed[0];
      if (
        !result ||
        !['LICENSE', 'NOTICE'].every((file) => result.files.some(({ path }) => path === file))
      ) {
        throw new Error(`Missing license or notice in ${manifest.name}.`);
      }
      if (result.files.some(({ path }) => /(^|\/)(src|_tests_?|node_modules)\//.test(path))) {
        throw new Error(`Unexpected source or dependencies in ${manifest.name}.`);
      }
      const archive = await readFile(join(releaseDirectory, result.filename));
      checksums.push(`${createHash('sha256').update(archive).digest('hex')}  ${result.filename}`);
      console.log(
        `${manifest.name}@${manifest.version}: ${join(releaseDirectory, result.filename)}`,
      );
    }
    await writeFile(join(releaseDirectory, 'SHA256SUMS'), `${checksums.sort().join('\n')}\n`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
};

await packRelease();
