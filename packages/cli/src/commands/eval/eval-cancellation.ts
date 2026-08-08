import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';

import { AttestCliError } from '../../errors.js';

const execFileAsync = promisify(execFile);
const EVAL_REGISTRY_DIRECTORY = join('.attest', 'eval-runs');

type EvalRegistryRecord = {
  pid: number;
  process_start: string;
  run_id: string;
  token: string;
};

type EvalRegistryHandle = {
  path: string;
  record: EvalRegistryRecord;
};

const getErrorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof Reflect.get(error, 'code') === 'string'
    ? (Reflect.get(error, 'code') as string)
    : undefined;

/** Reads the OS process start marker used to reject a stale registry after PID reuse. */
const processStartMarker = async (pid: number): Promise<string | undefined> => {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2_000,
    });
    const marker = stdout.trim().replace(/\s+/gu, ' ');
    return marker.length === 0 ? undefined : marker;
  } catch {
    return undefined;
  }
};

/** Creates and verifies the project-contained registry directory without following a symlink. */
const ensureRegistryDirectory = async (projectRoot: string): Promise<string> => {
  const directory = join(projectRoot, EVAL_REGISTRY_DIRECTORY);
  await mkdir(directory, { recursive: true });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new AttestCliError('run_failed', 'The eval cancellation registry is unsafe.', {
      path: EVAL_REGISTRY_DIRECTORY,
    });
  }
  return directory;
};

/** Publishes one atomic active-run record that can be safely addressed by a separate CLI process. */
const registerEvalRun = async (projectRoot: string, runId: string): Promise<EvalRegistryHandle> => {
  const processStart = await processStartMarker(process.pid);
  if (processStart === undefined) {
    throw new AttestCliError('run_failed', 'Could not identify the eval process for cancellation.');
  }
  const directory = await ensureRegistryDirectory(projectRoot);
  const record: EvalRegistryRecord = {
    pid: process.pid,
    process_start: processStart,
    run_id: runId,
    token: randomUUID(),
  };
  const path = join(directory, `${runId}.json`);
  const temporaryPath = join(directory, `.${runId}.${record.token}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error: unknown) {
    await unlink(temporaryPath).catch(() => undefined);
    throw new AttestCliError('run_failed', 'Could not publish the eval cancellation registry.', {
      path: EVAL_REGISTRY_DIRECTORY,
      cause: error,
    });
  }
  return { path, record };
};

/** Removes only the registry generation owned by this run, tolerating an already-cleaned record. */
const unregisterEvalRun = async (handle: EvalRegistryHandle): Promise<void> => {
  try {
    const current = JSON.parse(await readFile(handle.path, 'utf8')) as Partial<EvalRegistryRecord>;
    if (current.token === handle.record.token) await unlink(handle.path);
  } catch (error: unknown) {
    if (getErrorCode(error) !== 'ENOENT') {
      throw new AttestCliError('run_failed', 'Could not clean the eval cancellation registry.', {
        path: EVAL_REGISTRY_DIRECTORY,
        cause: error,
      });
    }
  }
};

const parseRegistryRecord = (value: unknown, runId: string): EvalRegistryRecord | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<EvalRegistryRecord>;
  return candidate.run_id === runId &&
    Number.isInteger(candidate.pid) &&
    (candidate.pid ?? 0) > 0 &&
    typeof candidate.process_start === 'string' &&
    candidate.process_start.length > 0 &&
    typeof candidate.token === 'string' &&
    candidate.token.length > 0
    ? (candidate as EvalRegistryRecord)
    : undefined;
};

/** Signals one matching live run and refuses stale or malformed PID records. */
const signalRegisteredEvalRun = async (
  projectRoot: string,
  runId: string,
): Promise<'cancellation_requested' | 'not_active'> => {
  const path = join(projectRoot, EVAL_REGISTRY_DIRECTORY, `${runId}.json`);
  let record: EvalRegistryRecord | undefined;
  try {
    record = parseRegistryRecord(JSON.parse(await readFile(path, 'utf8')) as unknown, runId);
  } catch (error: unknown) {
    if (getErrorCode(error) === 'ENOENT') return 'not_active';
  }
  if (record === undefined) return 'not_active';

  const currentStart = await processStartMarker(record.pid);
  if (currentStart !== record.process_start) {
    await unlink(path).catch(() => undefined);
    return 'not_active';
  }
  try {
    process.kill(record.pid, 'SIGTERM');
    return 'cancellation_requested';
  } catch (error: unknown) {
    if (getErrorCode(error) === 'ESRCH') {
      await unlink(path).catch(() => undefined);
      return 'not_active';
    }
    throw new AttestCliError('run_failed', 'Could not signal the active eval process.', {
      path: runId,
      cause: error,
    });
  }
};

export {
  EVAL_REGISTRY_DIRECTORY,
  processStartMarker,
  registerEvalRun,
  signalRegisteredEvalRun,
  unregisterEvalRun,
  type EvalRegistryHandle,
};
