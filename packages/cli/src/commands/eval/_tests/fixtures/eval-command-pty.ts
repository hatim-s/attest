import { createInterface } from 'node:readline/promises';

import { CLI_EVENT_SCHEMA_ID, CLI_RESULT_SCHEMA_ID, type EvalEvent } from '@attest/contracts';
import { Command } from 'commander';

import { registerEvalCommands } from '../../eval-command.js';

const RUN_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SNAPSHOT_HASH = 'f'.repeat(64);

/** Waits for the command signal so the PTY driver can verify cancellation and terminal cleanup. */
const cancellationEvents = async function* (signal: AbortSignal): AsyncGenerator<EvalEvent> {
  yield {
    schema: CLI_EVENT_SCHEMA_ID,
    sequence: 0,
    time: new Date().toISOString(),
    event: 'run_started',
    data: {
      run_id: RUN_ID,
      snapshot_hash: SNAPSHOT_HASH,
      total_cases: 0,
      concurrency: 1,
      timeout_ms: 60_000,
    },
  };
  if (!signal.aborted) {
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
  }
  const summary = {
    total_cases: 0,
    passed_cases: 0,
    failed_cases: 0,
    error_cases: 0,
    metric_error_count: 0,
  };
  yield {
    schema: CLI_EVENT_SCHEMA_ID,
    sequence: 1,
    time: new Date().toISOString(),
    event: 'run_completed',
    data: { run_id: RUN_ID, status: 'cancelled', summary },
  };
  yield {
    schema: CLI_EVENT_SCHEMA_ID,
    sequence: 2,
    time: new Date().toISOString(),
    event: 'result',
    data: {
      exit_code: 130,
      result: {
        schema: CLI_RESULT_SCHEMA_ID,
        ok: false,
        command: 'eval.run',
        error: {
          code: 'cancelled',
          message: 'Evaluation was cancelled by a process signal.',
          retryable: true,
        },
      },
    },
  };
};

/** Runs the isolated eval command seam in a real terminal without root-command integration. */
const main = async (): Promise<void> => {
  const program = new Command().name('attest').exitOverride();
  let exitCode = 0;
  registerEvalCommands({
    interaction: {
      ci: false,
      inputIsTTY: process.stdin.isTTY === true,
      outputIsTTY: process.stdout.isTTY === true,
      prompt: async (question, options) => {
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return options?.signal === undefined
            ? await prompt.question(question)
            : await prompt.question(question, { signal: options.signal });
        } finally {
          prompt.close();
        }
      },
      readStdin: () => Promise.resolve(''),
    },
    io: { error: (message) => console.error(message), output: (message) => console.log(message) },
    program,
    services: {
      cancel: () => Promise.reject(new Error('cancel must not be called')),
      run: (_request, { signal }) => Promise.resolve(cancellationEvents(signal)),
    },
    setExitCode: (value) => {
      exitCode = value;
    },
    workingDirectory: process.cwd(),
  });
  await program.parseAsync(['eval', 'run', '--watch'], { from: 'user' });
  process.exitCode = exitCode;
};

await main();
