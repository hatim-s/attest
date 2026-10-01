import { isAbsolute, posix, relative, resolve, sep } from 'node:path';

const SANDBOX_WORKSPACE = '/vercel/sandbox/workspace';
const GLOB_METACHARACTERS = /[*?\[\]{}]/u;

/** True when `path` is `root` itself or lies below it. */
const isContained = (root: string, path: string): boolean => {
  const fromRoot = relative(root, path);
  return (
    fromRoot === '' ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..' && !isAbsolute(fromRoot))
  );
};

/** Rejects paths whose meaning could vary between file APIs and command execution. */
const assertLiteralRelativePath = (value: string, label: string): void => {
  if (
    value.length === 0 ||
    value.includes('\0') ||
    isAbsolute(value) ||
    posix.isAbsolute(value) ||
    GLOB_METACHARACTERS.test(value)
  ) {
    throw new TypeError(`${label} must be a non-empty literal relative path.`);
  }
};

/** Resolves an authored relative sandbox path below the fixed workspace root. */
const resolveRemotePath = (value: string): string => {
  assertLiteralRelativePath(value, 'Sandbox resource path');
  const resolved = posix.resolve(SANDBOX_WORKSPACE, value);
  if (resolved !== SANDBOX_WORKSPACE && !resolved.startsWith(`${SANDBOX_WORKSPACE}/`)) {
    throw new TypeError(`Sandbox path escapes ${SANDBOX_WORKSPACE}: ${value}`);
  }
  return resolved;
};

/** Resolves artifact outputs below the configured host artifact directory. */
const resolveArtifactDestination = (root: string, value: string): string => {
  assertLiteralRelativePath(value, 'Artifact destination');
  const destination = resolve(root, value);
  const fromRoot = relative(resolve(root), destination);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new TypeError(`Artifact destination escapes its root: ${value}`);
  }
  return destination;
};

export {
  SANDBOX_WORKSPACE,
  assertLiteralRelativePath,
  isContained,
  resolveArtifactDestination,
  resolveRemotePath,
};
