import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, realpath, symlink } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';

type PackageManifest = {
  name: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

type PackedWorkspace = { archive: string; source: string };

const execFileAsync = promisify(execFile);

/** Resolves a dependency from the installed package's physical location, as Node does. */
const resolveInstalledPackage = async (
  source: string,
  name: string,
): Promise<string | undefined> => {
  let directory = source;
  while (true) {
    try {
      return await realpath(join(directory, 'node_modules', name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
};

/**
 * Extracts packed workspaces and copies their installed dependency closure without registry access.
 * Each physical source package gets one owned destination, preserving duplicate versions and cycles.
 * The release check separately verifies npm installation and published dependency resolution.
 */
const materializePackedRuntime = async (
  runtime: string,
  workspaces: Record<string, PackedWorkspace>,
): Promise<string> => {
  const destinations = new Map<string, string>();
  const pending: Array<{ source: string; destination: string }> = [];

  for (const [name, workspace] of Object.entries(workspaces)) {
    const source = await realpath(workspace.source);
    const destination = join(runtime, 'node_modules', name);
    await mkdir(destination, { recursive: true });
    await execFileAsync('tar', [
      '-xzf',
      workspace.archive,
      '--strip-components=1',
      '-C',
      destination,
    ]);
    destinations.set(source, destination);
    pending.push({ source, destination });
  }

  for (let index = 0; index < pending.length; index += 1) {
    const { source, destination } = pending[index]!;
    const manifest = JSON.parse(
      await readFile(join(destination, 'package.json'), 'utf8'),
    ) as PackageManifest;
    const dependencyNames = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    for (const name of dependencyNames) {
      const dependencySource = await resolveInstalledPackage(source, name);
      if (dependencySource === undefined) {
        const optional =
          Object.hasOwn(manifest.optionalDependencies ?? {}, name) ||
          manifest.peerDependenciesMeta?.[name]?.optional === true;
        if (optional) continue;
        throw new Error(
          `Installed dependency ${name} is missing for ${manifest.name}. Run bun install --frozen-lockfile.`,
        );
      }

      let dependencyDestination = destinations.get(dependencySource);
      if (dependencyDestination === undefined) {
        dependencyDestination = join(runtime, 'dependencies', String(destinations.size));
        destinations.set(dependencySource, dependencyDestination);
        await cp(dependencySource, dependencyDestination, {
          recursive: true,
          dereference: true,
          // Reconstruct package links from their actual resolutions instead of copying ambient links.
          filter: (path) => basename(path) !== 'node_modules',
        });
        pending.push({ source: dependencySource, destination: dependencyDestination });
      }
      const link = join(destination, 'node_modules', name);
      await mkdir(dirname(link), { recursive: true });
      await symlink(relative(dirname(link), dependencyDestination), link, 'dir');
    }
  }

  const binaryDirectory = join(runtime, 'node_modules', '.bin');
  await mkdir(binaryDirectory, { recursive: true });
  const cliPath = join(binaryDirectory, 'attest');
  await symlink('../@attest/cli/dist/cli.js', cliPath);
  return cliPath;
};

export { materializePackedRuntime };
