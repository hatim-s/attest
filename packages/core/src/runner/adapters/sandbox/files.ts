import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { posix } from 'node:path';

import { AgentInvocationError } from '../../errors.js';
import { BoundedTailWritable } from './bounded-writable.js';
import type { VercelSandboxResource, VercelSandboxSdk } from './types.js';

type LoadedUpload = { path: string; content: Uint8Array; mode?: number };
type StagedArtifact = { directory: string; stagedPath: string };

const SANDBOX_WORKSPACE = '/vercel/sandbox/workspace';
const GLOB_METACHARACTERS = /[*?\[\]{}]/u;

const ensurePositiveCap = (value: number): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('Response byte cap must be a positive safe integer.');
  }
};

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

/** Rejects existing symlink components while allowing not-yet-created output directories. */
const assertNoSymlinkComponents = async (
  root: string,
  path: string,
  allowMissing: boolean,
): Promise<void> => {
  if (!isContained(root, path)) throw new TypeError(`Host path escapes its root: ${path}`);
  const fromRoot = relative(root, path);
  let current = root;
  for (const segment of fromRoot.split(sep).filter((part) => part.length > 0)) {
    current = resolve(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink())
        throw new TypeError(`Host path contains a symbolic link: ${current}`);
    } catch (error: unknown) {
      if (
        allowMissing &&
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return;
      }
      throw error;
    }
  }
};

const readBoundedHostFile = async (
  handle: Awaited<ReturnType<typeof open>>,
  responseBytes: number,
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for (;;) {
    const remaining = responseBytes - bytes;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining + 1));
    const read = await handle.read(buffer, 0, buffer.length, null);
    if (read.bytesRead === 0) return Buffer.concat(chunks, bytes);
    bytes += read.bytesRead;
    if (bytes > responseBytes) {
      throw new AgentInvocationError(
        'output_cap_exceeded',
        'Sandbox upload grew beyond limits.response_bytes while reading.',
      );
    }
    chunks.push(buffer.subarray(0, read.bytesRead));
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

/** Opens every authored upload without following a terminal symlink and enforces the response cap. */
const loadExplicitUploads = async (
  projectRoot: string,
  uploads: VercelSandboxResource['files'],
  responseBytes: number,
): Promise<LoadedUpload[]> => {
  ensurePositiveCap(responseBytes);
  const loaded: LoadedUpload[] = [];
  let totalBytes = 0;
  const root = await realpath(projectRoot);
  for (const upload of uploads) {
    assertLiteralRelativePath(upload.source, 'Sandbox upload source');
    const source = resolve(root, upload.source);
    let handle;
    try {
      await assertNoSymlinkComponents(root, source, false);
      handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stats = await handle.stat();
      if (!stats.isFile())
        throw new TypeError(`Sandbox upload is not a regular file: ${upload.source}`);
      if (stats.size > responseBytes) {
        throw new AgentInvocationError(
          'output_cap_exceeded',
          `Sandbox upload exceeds limits.response_bytes: ${upload.source}`,
        );
      }
      const content = await readBoundedHostFile(handle, responseBytes);
      totalBytes += content.length;
      if (totalBytes > responseBytes) {
        throw new AgentInvocationError(
          'output_cap_exceeded',
          'Sandbox uploads exceed limits.response_bytes in aggregate.',
        );
      }
      loaded.push({
        path: resolveRemotePath(upload.destination),
        content,
        ...(upload.mode === undefined ? {} : { mode: upload.mode }),
      });
    } catch (error: unknown) {
      if (error instanceof AgentInvocationError || error instanceof TypeError) throw error;
      throw new AgentInvocationError(
        'spawn_failed',
        `Could not read sandbox upload: ${upload.source}`,
        {
          cause: error,
        },
      );
    } finally {
      await handle?.close();
    }
  }
  return loaded;
};

const runFileTest = async (
  sandbox: VercelSandboxSdk,
  flag: '-L' | '-f',
  path: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> => {
  const stdout = new BoundedTailWritable(1024);
  const stderr = new BoundedTailWritable(1024);
  const result = await sandbox.runCommand({
    cmd: 'test',
    args: [flag, path],
    stdout,
    stderr,
    timeoutMs,
    signal,
  });
  return result.exitCode === 0;
};

/** Rejects a remote file when it or any parent below the workspace is a symbolic link. */
const assertRemoteRegularFile = async (
  sandbox: VercelSandboxSdk,
  path: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> => {
  const relativePath = posix.relative(SANDBOX_WORKSPACE, path);
  let current = SANDBOX_WORKSPACE;
  for (const segment of relativePath.split('/')) {
    current = posix.join(current, segment);
    if (await runFileTest(sandbox, '-L', current, timeoutMs, signal)) {
      throw new AgentInvocationError(
        'network',
        `Sandbox artifact path contains a symbolic link: ${path}`,
      );
    }
  }
  if (!(await runFileTest(sandbox, '-f', path, timeoutMs, signal))) {
    throw new AgentInvocationError(
      'network',
      `Sandbox artifact is missing or not a regular file: ${path}`,
    );
  }
};

/** Streams one remote file into a bounded host buffer and destroys the stream on overflow. */
const readRemoteFile = async (
  sandbox: VercelSandboxSdk,
  path: string,
  responseBytes: number,
  signal: AbortSignal,
): Promise<Buffer | null> => {
  const readFile: (
    file: { path: string },
    options: { signal: AbortSignal },
  ) => Promise<NodeJS.ReadableStream | null> = sandbox.readFile;
  const stream = await readFile({ path }, { signal });
  if (stream === null) return null;
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stream as NodeJS.ReadableStream & AsyncIterable<Buffer | string>) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > responseBytes) {
        throw new AgentInvocationError(
          'output_cap_exceeded',
          `Sandbox artifact exceeds limits.response_bytes: ${path}`,
        );
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    const destroyable = stream as NodeJS.ReadableStream & { destroy?: () => void };
    destroyable.destroy?.();
  }
};

/** Stages all terminal artifacts beside their destinations, then publishes each with rename. */
const publishTerminalArtifacts = async (
  sandbox: VercelSandboxSdk,
  artifacts: NonNullable<VercelSandboxResource['artifacts']>,
  projectRoot: string,
  configuredArtifactRoot: string,
  responseBytes: number,
  commandTimeoutMs: number,
  signal: AbortSignal,
): Promise<void> => {
  ensurePositiveCap(responseBytes);
  const staged: StagedArtifact[] = [];
  let totalBytes = 0;
  const configuredProjectRoot = resolve(projectRoot);
  const root = await realpath(projectRoot);
  const configuredRoot = resolve(configuredArtifactRoot);
  if (!isContained(configuredProjectRoot, configuredRoot)) {
    throw new TypeError(`Artifact root escapes the project root: ${configuredArtifactRoot}`);
  }
  const artifactRoot = resolve(root, relative(configuredProjectRoot, configuredRoot));
  await assertNoSymlinkComponents(root, artifactRoot, true);
  try {
    for (const artifact of artifacts) {
      const source = resolveRemotePath(artifact.source);
      await assertRemoteRegularFile(sandbox, source, commandTimeoutMs, signal);
      const content = await readRemoteFile(sandbox, source, responseBytes, signal);
      if (content === null) {
        throw new AgentInvocationError(
          'network',
          `Sandbox artifact disappeared before download: ${artifact.source}`,
        );
      }
      totalBytes += content.length;
      if (totalBytes > responseBytes) {
        throw new AgentInvocationError(
          'output_cap_exceeded',
          'Sandbox artifacts exceed limits.response_bytes in aggregate.',
        );
      }

      const destination = resolveArtifactDestination(artifactRoot, artifact.destination);
      await assertNoSymlinkComponents(root, destination, true);
      const parent = dirname(destination);
      await mkdir(parent, { recursive: true });
      await assertNoSymlinkComponents(root, parent, false);
      if (!isContained(root, await realpath(parent))) {
        throw new TypeError(`Artifact parent escapes the project root: ${artifact.destination}`);
      }
      const directory = await mkdtemp(resolve(parent, '.attest-stage-'));
      const stagedPath = resolve(directory, 'artifact');
      await writeFile(stagedPath, content, { flag: 'wx' });
      staged.push({ directory, stagedPath });
      // Publish each validated file atomically so a later missing artifact does not discard
      // evidence already recovered from a failed terminal attempt.
      await rename(stagedPath, destination);
    }
  } finally {
    await Promise.all(
      staged.map((artifact) => rm(artifact.directory, { recursive: true, force: true })),
    );
  }
};

export {
  loadExplicitUploads,
  publishTerminalArtifacts,
  resolveArtifactDestination,
  resolveRemotePath,
  SANDBOX_WORKSPACE,
};
export type { LoadedUpload };
