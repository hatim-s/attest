import { connect } from 'node:net';

import { AgentInvocationError } from '../../errors.js';
import { abortableWait } from '../../internal/abortable-wait.js';
import type { BackgroundAgentResource } from './background-adapter.js';
import { assertLoopbackUrl, loopbackHost } from './loopback-url.js';
import type { ManagedChild } from './managed-child.js';

const READINESS_INTERVAL_MS = 50;
const READINESS_BUFFER_CHARACTERS = 16 * 1024;

type ReadinessWait = {
  process: ManagedChild;
  /** Aborts on the startup deadline or when the run ends. */
  signal: AbortSignal;
  /** Classifies an aborted wait as cancelled or timed out. */
  abortError: () => AgentInvocationError;
};

const tcpReady = (host: string, port: number, signal: AbortSignal): Promise<boolean> =>
  new Promise((resolve) => {
    if (!loopbackHost(host) || signal.aborted) {
      resolve(false);
      return;
    }
    const socket = connect({ host, port });
    const finish = (ready: boolean): void => {
      signal.removeEventListener('abort', abort);
      socket.destroy();
      resolve(ready);
    };
    const abort = (): void => finish(false);
    signal.addEventListener('abort', abort, { once: true });
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });

const httpReady = async (endpoint: URL, signal: AbortSignal): Promise<boolean> => {
  try {
    const response = await fetch(endpoint, { redirect: 'manual', signal });
    await response.body?.cancel().catch(() => undefined);
    return response.status >= 200 && response.status < 300;
  } catch {
    return false;
  }
};

type Readiness = BackgroundAgentResource['transport']['readiness'];
type PolledReadiness = Exclude<Readiness, { kind: 'stderr' }>;

/** Builds the connection probe for HTTP or TCP readiness, validating the target once. */
const readinessProbe = (
  readiness: PolledReadiness,
): ((signal: AbortSignal) => Promise<boolean>) => {
  if (readiness.kind === 'tcp') {
    return (signal) => tcpReady(readiness.host, readiness.port, signal);
  }
  const endpoint = assertLoopbackUrl(readiness.url);
  return (signal) => httpReady(endpoint, signal);
};

/** Resolves once stderr matches the authored pattern; a process exit first is a failure. */
const waitForStderrPattern = async (source: string, wait: ReadinessWait): Promise<void> => {
  const { process, signal } = wait;
  let pattern: RegExp;
  try {
    pattern = new RegExp(source, 'u');
  } catch (error: unknown) {
    throw new AgentInvocationError('invalid_envelope', 'Background readiness regex is invalid.', {
      cause: error,
    });
  }
  let retained = process.stderrExcerpt() ?? '';
  if (pattern.test(retained)) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      process.stderr.off('data', data);
      operation();
    };
    const abort = (): void => finish(() => reject(wait.abortError()));
    const data = (chunk: Buffer): void => {
      retained = `${retained}${chunk.toString('utf8')}`.slice(-READINESS_BUFFER_CHARACTERS);
      if (pattern.test(retained)) finish(resolve);
    };
    void process.exit.then(({ code, signal: exitSignal }) =>
      finish(() =>
        reject(
          new AgentInvocationError(
            'nonzero_exit',
            `Background agent exited before stderr readiness (code ${String(code)}, signal ${String(exitSignal)}).`,
          ),
        ),
      ),
    );
    signal.addEventListener('abort', abort, { once: true });
    process.stderr.on('data', data);
    if (signal.aborted) abort();
  });
};

/** Probes an HTTP or TCP readiness target until it answers, the process exits, or time runs out. */
const pollReadiness = async (readiness: PolledReadiness, wait: ReadinessWait): Promise<void> => {
  const { process, signal } = wait;
  const probe = readinessProbe(readiness);
  for (;;) {
    if (signal.aborted) throw wait.abortError();
    if (!process.running) {
      throw new AgentInvocationError(
        'nonzero_exit',
        'Background agent exited before becoming ready.',
      );
    }
    if (await probe(signal)) return;
    await abortableWait(READINESS_INTERVAL_MS, signal, wait.abortError);
  }
};

/** Blocks until the authored readiness contract succeeds. */
const waitForReadiness = (readiness: Readiness, wait: ReadinessWait): Promise<void> =>
  readiness.kind === 'stderr'
    ? waitForStderrPattern(readiness.pattern, wait)
    : pollReadiness(readiness, wait);

export { waitForReadiness };
