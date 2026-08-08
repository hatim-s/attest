import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';

import { AgentInvocationError } from '../../errors.js';
import {
  killProcessTree,
  listDescendantProcesses,
  type ProcessIdentity,
} from '../../internal/process-tree.js';

type ManagedChildOptions = {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  stderrCapBytes: number;
};

type ProcessExit = { code: number | null; signal: NodeJS.Signals | null };

/** Owns one detached process group and bounded stderr evidence for a run-scoped adapter. */
class ManagedChild {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exit: Promise<ProcessExit>;
  private readonly stderrChunks: Buffer[] = [];
  private stderrBytes = 0;
  private stderrTruncated = false;
  private descendants: ProcessIdentity[] = [];

  private constructor(child: ChildProcessWithoutNullStreams, stderrCapBytes: number) {
    this.child = child;
    this.child.stderr.on('data', (chunk: Buffer) => {
      const remaining = Math.max(0, stderrCapBytes - this.stderrBytes);
      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining);
        this.stderrChunks.push(retained);
        this.stderrBytes += retained.byteLength;
      }
      if (chunk.byteLength > remaining) this.stderrTruncated = true;
    });
    this.exit = new Promise((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
  }

  /** Spawns argv directly, never through a shell, and waits for the OS spawn boundary. */
  static async start(options: ManagedChildOptions): Promise<ManagedChild> {
    const [executable, ...argumentsList] = options.argv;
    if (executable === undefined) throw new TypeError('Managed process argv cannot be empty.');
    const child = spawn(executable, argumentsList, {
      cwd: options.cwd,
      detached: true,
      env: options.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const managed = new ManagedChild(child, options.stderrCapBytes);
    await new Promise<void>((resolve, reject) => {
      const spawned = (): void => {
        child.off('error', failed);
        resolve();
      };
      const failed = (error: Error): void => {
        child.off('spawn', spawned);
        reject(
          new AgentInvocationError('spawn_failed', 'Managed agent process failed to spawn.', {
            cause: error,
          }),
        );
      };
      child.once('spawn', spawned);
      child.once('error', failed);
    });
    // Later process errors are represented by stream/exit state and must not become uncaught events.
    child.on('error', () => undefined);
    return managed;
  }

  /** Writes one complete protocol frame while honoring Node stream backpressure. */
  async writeLine(value: unknown): Promise<void> {
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new AgentInvocationError('network', 'Managed agent stdin is unavailable.');
    }
    const accepted = this.child.stdin.write(`${JSON.stringify(value)}\n`, 'utf8');
    if (!accepted) await once(this.child.stdin, 'drain');
  }

  /** Captures descendants before a graceful stop so daemonized children remain cleanup targets. */
  async snapshotDescendants(): Promise<void> {
    const processId = this.child.pid;
    if (processId === undefined) return;
    this.descendants = await listDescendantProcesses(processId);
  }

  /** Returns bounded stderr text; callers redact runtime secrets before persistence. */
  stderrExcerpt(): string | undefined {
    if (this.stderrBytes === 0) return undefined;
    const suffix = this.stderrTruncated ? '\n[stderr truncated]' : '';
    return `${Buffer.concat(this.stderrChunks, this.stderrBytes).toString('utf8')}${suffix}`;
  }

  /** Applies TERM/grace/KILL to the owned group and verifies known descendants. */
  async terminate(graceMs: number): Promise<number[]> {
    await this.snapshotDescendants();
    return killProcessTree(this.child, {
      graceMs,
      initialDescendants: this.descendants,
      signalProcessGroup: this.child.exitCode === null && this.child.signalCode === null,
    });
  }
}

export { ManagedChild, type ManagedChildOptions, type ProcessExit };
