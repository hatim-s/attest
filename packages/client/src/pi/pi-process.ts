import { spawn } from 'node:child_process';

import { createLineFramer } from './line-framer.js';
import { parsePiRecord, type PiRecord } from './pi-records.js';

// One record can carry a whole tool result or final message; anything larger is not Pi.
const MAX_LINE_BYTES = 16 * 1024 * 1024;

const STDERR_TAIL_CHARS = 8 * 1024;

// After stdin closes Pi disposes its runtime; this long it may take before it is signalled.
const SHUTDOWN_GRACE_MS = 5_000;

const KILL_GRACE_MS = 2_000;

const PROMPT_ID = 'attest-prompt';

type PiProcessInput = {
  argv: readonly [string, ...string[]];
  cwd: string;
  env: NodeJS.ProcessEnv;
  message: string;
  signal: AbortSignal;
  timeoutMs: number;
  onRecord: (record: PiRecord) => void;
};

/** How one Pi run ended. Every outcome is reported only after the process has exited. */
type PiProcessOutcome =
  | { kind: 'settled'; aborted: boolean }
  | { kind: 'handled' }
  | { kind: 'rejected'; message: string }
  | { kind: 'exited'; code: number | null; signal: NodeJS.Signals | null; stderr: string }
  | { kind: 'spawn_failed'; message: string }
  | { kind: 'protocol_error'; message: string }
  | { kind: 'timeout' }
  | { kind: 'cancelled' };

/**
 * Runs one prompt through `pi --mode rpc`. Stdin stays open until `agent_settled`, because Pi
 * treats stdin EOF as a shutdown request. A settled run shuts down by closing stdin; every other
 * ending (abort, timeout, protocol violation, rejected prompt) kills Pi's whole process group so
 * tool subprocesses such as `bash` children die with it.
 */
const runPiProcess = ({
  argv,
  cwd,
  env,
  message,
  signal,
  timeoutMs,
  onRecord,
}: PiProcessInput): Promise<PiProcessOutcome> => {
  if (signal.aborted) return Promise.resolve({ kind: 'cancelled' });
  const [command, ...args] = argv;

  return new Promise((resolve) => {
    // detached puts Pi in its own process group, which is what makes the group kill possible.
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    const framer = createLineFramer(MAX_LINE_BYTES);
    const timers: NodeJS.Timeout[] = [];
    let stderr = '';
    let outcome: PiProcessOutcome | undefined;

    const killGroup = (killSignal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;

      try {
        process.kill(-child.pid, killSignal);
      } catch {
        // ESRCH: the group is already gone.
      }
    };

    const onAbort = (): void => conclude({ kind: 'cancelled' });

    /** Records the first terminal outcome and starts shutting Pi down; later ones are ignored. */
    const conclude = (result: PiProcessOutcome): void => {
      if (outcome !== undefined) return;
      outcome = result;
      signal.removeEventListener('abort', onAbort);
      timers.forEach(clearTimeout);

      if (result.kind === 'settled' || result.kind === 'handled') {
        child.stdin.end();
        timers.push(setTimeout(() => killGroup('SIGTERM'), SHUTDOWN_GRACE_MS));
        timers.push(setTimeout(() => killGroup('SIGKILL'), SHUTDOWN_GRACE_MS + KILL_GRACE_MS));
      } else {
        killGroup('SIGTERM');
        timers.push(setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS));
      }
    };

    const onLine = (line: string): void => {
      const record = parsePiRecord(line);

      if (record === undefined || outcome !== undefined) return;
      onRecord(record);

      if (record.type === 'agent_settled') {
        conclude({ kind: 'settled', aborted: record.aborted });
      } else if (record.type === 'response' && record.id === PROMPT_ID) {
        if (!record.success) {
          conclude({ kind: 'rejected', message: record.error ?? 'Pi rejected the prompt.' });
        } else if (record.data?.disposition === 'handled') {
          // No run starts for a handled prompt, so no agent_settled follows.
          conclude({ kind: 'handled' });
        }
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      const lines = framer.push(chunk);

      if (lines === undefined) {
        conclude({
          kind: 'protocol_error',
          message: `Pi wrote a stdout line over ${String(MAX_LINE_BYTES)} bytes.`,
        });

        return;
      }

      lines.forEach(onLine);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
    });

    // EPIPE after Pi exits is reported through the exit outcome instead.
    child.stdin.on('error', () => undefined);

    child.on('error', (error) => {
      if (child.pid !== undefined) return;
      outcome ??= { kind: 'spawn_failed', message: error.message };
      timers.forEach(clearTimeout);
      signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    });

    // Pi exiting early must not wait on 'close': a tool subprocess holding stdout open would delay
    // it until the timeout. Concluding kills the rest of the group, which releases the pipes.
    child.on('exit', (code, exitSignal) => {
      conclude({ kind: 'exited', code, signal: exitSignal, stderr: stderr.trim() });
    });

    child.on('close', (code, exitSignal) => {
      timers.forEach(clearTimeout);
      signal.removeEventListener('abort', onAbort);
      resolve(outcome ?? { kind: 'exited', code, signal: exitSignal, stderr: stderr.trim() });
    });

    signal.addEventListener('abort', onAbort, { once: true });
    timers.push(setTimeout(() => conclude({ kind: 'timeout' }), timeoutMs));
    child.stdin.write(`${JSON.stringify({ id: PROMPT_ID, type: 'prompt', message })}\n`);
  });
};

export { runPiProcess, type PiProcessOutcome };
