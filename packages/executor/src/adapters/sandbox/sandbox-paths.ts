import { isAbsolute, posix, relative, resolve, sep } from 'node:path';

const SANDBOX_WORKSPACE = '/vercel/sandbox/workspace';

/** True when `path` is `root` itself or lies below it. */
const isContained = (root: string, path: string): boolean => {
  const fromRoot = relative(root, path);

  return (
    fromRoot === '' ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..' && !isAbsolute(fromRoot))
  );
};

/** Resolves an authored relative sandbox path below the fixed workspace root. */
const resolveRemotePath = (value: string): string => {
  // The project schema rejects empty, absolute, parent and glob paths but admits NUL bytes.
  if (value.includes('\0')) throw new TypeError('Sandbox path must not contain NUL bytes.');
  const resolved = posix.resolve(SANDBOX_WORKSPACE, value);

  if (resolved !== SANDBOX_WORKSPACE && !resolved.startsWith(`${SANDBOX_WORKSPACE}/`)) {
    throw new TypeError(`Sandbox path escapes ${SANDBOX_WORKSPACE}: ${value}`);
  }

  return resolved;
};

/** Resolves artifact outputs below the configured host artifact directory. */
const resolveArtifactDestination = (root: string, value: string): string => {
  const destination = resolve(root, value);
  const fromRoot = relative(resolve(root), destination);

  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new TypeError(`Artifact destination escapes its root: ${value}`);
  }

  return destination;
};

export { SANDBOX_WORKSPACE, isContained, resolveArtifactDestination, resolveRemotePath };
