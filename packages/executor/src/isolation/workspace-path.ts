import { posix } from 'node:path';

const JUST_BASH_WORKSPACE = '/workspace';

/** Normalizes a workspace-relative path and rejects paths that escape the workspace. */
const normalizeWorkspacePath = (value: string, label = 'Workspace path'): string => {
  if (value.length === 0 || value.includes('\0') || posix.isAbsolute(value)) {
    throw new TypeError(`${label} must be a non-empty relative path.`);
  }
  const normalized = posix.normalize(value);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new TypeError(`${label} must stay inside the workspace.`);
  }
  return normalized;
};

/** Converts authored seed files to the absolute paths expected by just-bash. */
const resolveJustBashFiles = (files: Readonly<Record<string, string>>): Record<string, string> => {
  const resolved: Record<string, string> = {};
  for (const [path, contents] of Object.entries(files)) {
    const destination = posix.join(
      JUST_BASH_WORKSPACE,
      normalizeWorkspacePath(path, 'Seed file path'),
    );
    if (destination in resolved) throw new TypeError(`Duplicate seed file path: ${path}`);
    resolved[destination] = contents;
  }
  return resolved;
};

/** Resolves one public file API path below the just-bash workspace. */
const resolveJustBashPath = (path: string): string =>
  posix.join(JUST_BASH_WORKSPACE, normalizeWorkspacePath(path));

export { JUST_BASH_WORKSPACE, normalizeWorkspacePath, resolveJustBashFiles, resolveJustBashPath };
