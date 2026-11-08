import * as Cause from 'effect/Cause';
import * as Exit from 'effect/Exit';
import * as Effect from 'effect/Effect';
import { foreign, withRelease } from '../../isolation/operation.js';
import { EnvironmentOperationError } from '../../isolation/environment-error.js';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, posix, relative, resolve, sep } from 'node:path';

import type { VercelSandbox } from '@attest/contracts';

import { AgentInvocationError } from '../../errors.js';
import { errnoCode } from '../../internal/errno-code.js';
import { BoundedTailWritable } from './bounded-writable.js';
import {
  SANDBOX_WORKSPACE,
  isContained,
  resolveArtifactDestination,
  resolveRemotePath,
} from './sandbox-paths.js';
import type { VercelSandboxSdk } from './types.js';

type LoadedUpload = { path: string; content: Uint8Array; mode?: number };

type StagedArtifact = { directory: string; stagedPath: string };

/** Rejects existing symlink components while allowing not-yet-created output directories. */
const assertNoSymlinkComponents = Effect.fn(function* (
  root: string,
  path: string,
  allowMissing: boolean,
) {
  if (!isContained(root, path))
    return yield* new EnvironmentOperationError({ reason: 'host_path_escape', path });
  const fromRoot = relative(root, path);
  let current = root;

  for (const segment of fromRoot.split(sep).filter((part) => part.length > 0)) {
    current = resolve(current, segment);

    const stats = yield* foreign(() => lstat(current)).pipe(
      Effect.catchIf(
        (error) => allowMissing && errnoCode(error.cause) === 'ENOENT',
        () => Effect.succeed(undefined),
      ),
    );

    if (stats === undefined) return;

    if (stats.isSymbolicLink())
      return yield* new EnvironmentOperationError({ reason: 'host_path_symlink', path: current });
  }
}, Effect.uninterruptible);

/** Reads at most the configured bytes plus one overflow sentinel from an owned descriptor. */
const readBoundedHostFile = Effect.fn(function* (
  handle: Awaited<ReturnType<typeof open>>,
  responseBytes: number,
) {
  const chunks: Buffer[] = [];
  let bytes = 0;

  for (;;) {
    const remaining = responseBytes - bytes;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining + 1));
    const read = yield* foreign(() => handle.read(buffer, 0, buffer.length, null));

    if (read.bytesRead === 0) return Buffer.concat(chunks, bytes);
    bytes += read.bytesRead;

    if (bytes > responseBytes) {
      return yield* new AgentInvocationError(
        'output_cap_exceeded',
        'Sandbox upload grew beyond limits.response_bytes while reading.',
      );
    }

    chunks.push(buffer.subarray(0, read.bytesRead));
  }
}, Effect.uninterruptible);

/** Opens every authored upload without following a terminal symlink and enforces the response cap. */
const loadExplicitUploads = Effect.fn(function* (
  projectRoot: string,
  uploads: VercelSandbox['files'],
  responseBytes: number,
) {
  const loaded: LoadedUpload[] = [];
  let totalBytes = 0;
  const root = yield* foreign(() => realpath(projectRoot));

  for (const upload of uploads) {
    const source = resolve(root, upload.source);
    yield* assertNoSymlinkComponents(root, source, false);
    const handle = yield* foreign(() => open(source, constants.O_RDONLY | constants.O_NOFOLLOW));
    yield* withRelease(
      Effect.gen(function* () {
        const stats = yield* foreign(() => handle.stat());

        if (!stats.isFile())
          return yield* new EnvironmentOperationError({
            reason: 'upload_not_regular_file',
            path: upload.source,
          });

        if (stats.size > responseBytes) {
          return yield* new AgentInvocationError(
            'output_cap_exceeded',
            `Sandbox upload exceeds limits.response_bytes: ${upload.source}`,
          );
        }

        const content = yield* readBoundedHostFile(handle, responseBytes);
        totalBytes += content.length;

        if (totalBytes > responseBytes) {
          return yield* new AgentInvocationError(
            'output_cap_exceeded',
            'Sandbox uploads exceed limits.response_bytes in aggregate.',
          );
        }

        const loadedUpload: LoadedUpload = { path: resolveRemotePath(upload.destination), content };

        if (upload.mode !== undefined) loadedUpload.mode = upload.mode;
        loaded.push(loadedUpload);
      }),
      foreign(() => handle.close()),
    );
  }

  return loaded;
}, Effect.uninterruptible);

/** Executes one remote regular-file or symlink predicate without retaining unbounded output. */
const runFileTest = Effect.fn(function* (
  sandbox: VercelSandboxSdk,
  flag: '-L' | '-f',
  path: string,
  timeoutMs: number,
  signal: AbortSignal,
) {
  const stdout = new BoundedTailWritable(1024);
  const stderr = new BoundedTailWritable(1024);

  const result = yield* foreign((foreignSignal) =>
    sandbox.runCommand({
      cmd: 'test',
      args: [flag, path],
      stdout,
      stderr,
      timeoutMs,
      signal: AbortSignal.any([foreignSignal, signal]),
    }),
  );

  return result.exitCode === 0;
}, Effect.uninterruptible);

/** Rejects a remote file when it or any parent below the workspace is a symbolic link. */
const assertRemoteRegularFile = Effect.fn(function* (
  sandbox: VercelSandboxSdk,
  path: string,
  timeoutMs: number,
  signal: AbortSignal,
) {
  const relativePath = posix.relative(SANDBOX_WORKSPACE, path);
  let current = SANDBOX_WORKSPACE;

  for (const segment of relativePath.split('/')) {
    current = posix.join(current, segment);

    if (yield* runFileTest(sandbox, '-L', current, timeoutMs, signal)) {
      return yield* new AgentInvocationError(
        'network',
        `Sandbox artifact path contains a symbolic link: ${path}`,
      );
    }
  }

  if (!(yield* runFileTest(sandbox, '-f', path, timeoutMs, signal))) {
    return yield* new AgentInvocationError(
      'network',
      `Sandbox artifact is missing or not a regular file: ${path}`,
    );
  }
}, Effect.uninterruptible);

const isDestroyable = (
  stream: NonNullable<Awaited<ReturnType<VercelSandboxSdk['readFile']>>>,
): stream is NonNullable<Awaited<ReturnType<VercelSandboxSdk['readFile']>>> & {
  destroy: () => void;
} => 'destroy' in stream && typeof stream.destroy === 'function';

/** Streams one remote file into a bounded host buffer and destroys the stream on overflow. */
const readRemoteFile = Effect.fn(function* (
  sandbox: VercelSandboxSdk,
  path: string,
  responseBytes: number,
  signal: AbortSignal,
) {
  const stream = yield* foreign((foreignSignal) =>
    sandbox.readFile({ path }, { signal: AbortSignal.any([foreignSignal, signal]) }),
  );

  if (stream === null) return null;
  const chunks: Buffer[] = [];
  let bytes = 0;

  const iterator = stream[Symbol.asyncIterator]();

  return yield* withRelease(
    Effect.gen(function* () {
      for (;;) {
        const next = yield* foreign(() => iterator.next());

        if (next.done) break;
        const buffer = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
        bytes += buffer.length;

        if (bytes > responseBytes)
          return yield* new AgentInvocationError(
            'output_cap_exceeded',
            `Sandbox artifact exceeds limits.response_bytes: ${path}`,
          );
        chunks.push(buffer);
      }

      return Buffer.concat(chunks, bytes);
    }),
    Effect.sync(() => {
      if (isDestroyable(stream)) stream.destroy();
    }),
  );
}, Effect.uninterruptible);

/** Stages all terminal artifacts beside their destinations, then publishes each with rename. */
const publishTerminalArtifacts = Effect.fn(function* (
  sandbox: VercelSandboxSdk,
  artifacts: NonNullable<VercelSandbox['artifacts']>,
  options: {
    projectRoot: string;
    /** Host directory below the project root that receives the artifacts. */
    artifactRoot: string;
    responseBytes: number;
    commandTimeoutMs: number;
    signal: AbortSignal;
  },
) {
  const { commandTimeoutMs, projectRoot, responseBytes, signal } = options;
  const configuredArtifactRoot = options.artifactRoot;
  const staged: StagedArtifact[] = [];
  let totalBytes = 0;
  const configuredProjectRoot = resolve(projectRoot);
  const root = yield* foreign(() => realpath(projectRoot));
  const configuredRoot = resolve(configuredArtifactRoot);

  if (!isContained(configuredProjectRoot, configuredRoot)) {
    return yield* new EnvironmentOperationError({
      reason: 'artifact_root_escape',
      path: configuredArtifactRoot,
    });
  }

  const artifactRoot = resolve(root, relative(configuredProjectRoot, configuredRoot));
  yield* assertNoSymlinkComponents(root, artifactRoot, true);

  return yield* withRelease(
    Effect.gen(function* () {
      for (const artifact of artifacts) {
        const source = resolveRemotePath(artifact.source);
        yield* assertRemoteRegularFile(sandbox, source, commandTimeoutMs, signal);
        const content = yield* readRemoteFile(sandbox, source, responseBytes, signal);

        if (content === null) {
          return yield* new AgentInvocationError(
            'network',
            `Sandbox artifact disappeared before download: ${artifact.source}`,
          );
        }

        totalBytes += content.length;

        if (totalBytes > responseBytes) {
          return yield* new AgentInvocationError(
            'output_cap_exceeded',
            'Sandbox artifacts exceed limits.response_bytes in aggregate.',
          );
        }

        const destination = yield* Effect.try({
          try: () => resolveArtifactDestination(artifactRoot, artifact.destination),
          catch: (cause) => EnvironmentOperationError.from(cause, 'artifact_destination_invalid'),
        });

        yield* assertNoSymlinkComponents(root, destination, true);
        const parent = dirname(destination);
        yield* foreign(() => mkdir(parent, { recursive: true }));
        yield* assertNoSymlinkComponents(root, parent, false);

        if (!isContained(root, yield* foreign(() => realpath(parent)))) {
          return yield* new EnvironmentOperationError({
            reason: 'artifact_parent_escape',
            path: artifact.destination,
          });
        }

        const directory = yield* foreign(() => mkdtemp(resolve(parent, '.attest-stage-')));
        const stagedPath = resolve(directory, 'artifact');
        staged.push({ directory, stagedPath });
        yield* foreign(() => writeFile(stagedPath, content, { flag: 'wx' }));
        // Publish each validated file atomically so a later missing artifact does not discard
        // evidence already recovered from a failed terminal attempt.
        yield* foreign(() => rename(stagedPath, destination));
      }
    }),
    Effect.gen(function* () {
      // Attempt every stage removal, retaining each failure in the combined Exit.
      const exits = yield* Effect.forEach(staged, (artifact) =>
        Effect.exit(foreign(() => rm(artifact.directory, { recursive: true, force: true }))),
      );

      let cause: Cause.Cause<EnvironmentOperationError> = Cause.empty;

      for (const exit of exits) if (Exit.isFailure(exit)) cause = Cause.combine(cause, exit.cause);

      if (cause.reasons.length > 0) return yield* Effect.failCause(cause);
    }),
  );
}, Effect.uninterruptible);

export { loadExplicitUploads, publishTerminalArtifacts, readRemoteFile };
