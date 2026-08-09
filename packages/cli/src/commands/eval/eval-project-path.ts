import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { AttestCliError, type CliErrorCode } from '../../errors.js';

const getErrorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof Reflect.get(error, 'code') === 'string'
    ? (Reflect.get(error, 'code') as string)
    : undefined;

const isContainedPath = (root: string, candidate: string): boolean => {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === '' ||
    (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
  );
};

type PrepareEvalProjectFileOptions = {
  createDirectories?: boolean;
  errorCode: CliErrorCode;
  message: string;
};

/** Resolves one project-controlled file after rejecting traversal and symlinked path segments. */
const prepareEvalProjectFile = async (
  projectRoot: string,
  configuredPath: string,
  options: PrepareEvalProjectFileOptions,
): Promise<string> => {
  const resolvedRoot = await realpath(projectRoot);
  const candidate = resolve(resolvedRoot, configuredPath);
  const fromRoot = relative(resolvedRoot, candidate);
  const segments = fromRoot.split(sep);
  const authoredSegments = configuredPath.split('/');
  const unsafe = (): AttestCliError =>
    new AttestCliError(options.errorCode, options.message, { path: configuredPath });
  if (
    configuredPath.length === 0 ||
    configuredPath.includes('\0') ||
    configuredPath.includes('\\') ||
    isAbsolute(configuredPath) ||
    !isContainedPath(resolvedRoot, candidate) ||
    authoredSegments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    ) ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw unsafe();
  }

  let current = resolvedRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]!);
    const destination = index === segments.length - 1;
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(current);
    } catch (error: unknown) {
      if (getErrorCode(error) !== 'ENOENT') throw unsafe();
      if (destination || options.createDirectories !== true) break;
      try {
        await mkdir(current, { mode: 0o700 });
        metadata = await lstat(current);
      } catch {
        throw unsafe();
      }
    }
    if (
      metadata.isSymbolicLink() ||
      (!destination && !metadata.isDirectory()) ||
      (destination && !metadata.isFile())
    ) {
      throw unsafe();
    }
  }
  return candidate;
};

export { prepareEvalProjectFile, type PrepareEvalProjectFileOptions };
