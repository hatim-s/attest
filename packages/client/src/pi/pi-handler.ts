import { isJsonObject, isString, type JsonValue } from '@attest/contracts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectArtifacts } from '../node/collect-artifacts.js';
import { hashFiles } from '../node/workspace-files.js';
import type { AgentHandler, AgentInvocation, HandlerOutcome } from '../runner/agent-runner.js';
import { runPiProcess, type PiProcessOutcome } from './pi-process.js';
import { assistantText, type PiAssistantMessage } from './pi-records.js';
import { createPiTraceBuilder } from './pi-trace.js';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1_000;

/**
 * Keeps evals reproducible: no saved session, and no extensions, skills, prompt templates,
 * AGENTS.md files or MCP servers discovered from the machine. Explicit `-e <path>` arguments in
 * `argv` still load, because Pi honours them under `--no-extensions`.
 */
const PI_RPC_FLAGS = [
  '--mode',
  'rpc',
  '--no-session',
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-context-files',
  '--no-mcp',
] as const;

type PiHandlerOptions = {
  /** The Pi command and any extra arguments. Defaults to `['pi']`. */
  argv?: readonly [string, ...string[]];
  /** Passed as `--model`; also recorded as `gen_ai.request.model`. */
  model?: string;
  /** Passed as `--system-prompt` (text or a file path). */
  systemPrompt?: string;
  /** Picks the working directory. Defaults to a fresh temporary directory, removed afterwards. */
  workspace?: (invocation: AgentInvocation) => Promise<string>;
  /** Kills Pi if it has not settled by then. Defaults to 15 minutes. */
  timeoutMs?: number;
};

/** The prompt is the input itself when it is a string, else its string `prompt` field. */
const promptOf = (input: JsonValue): string | undefined => {
  if (isString(input)) return input;

  if (isJsonObject(input) && isString(input.prompt)) return input.prompt;

  return undefined;
};

const describeExit = (outcome: Extract<PiProcessOutcome, { kind: 'exited' }>): string => {
  const status = outcome.signal ?? `code ${String(outcome.code)}`;

  return `Pi exited (${status}) before the run settled.${outcome.stderr === '' ? '' : ` stderr: ${outcome.stderr}`}`;
};

/** Maps how Pi ended, plus its last assistant message, onto the completion outcome. */
const outcomeOf = (
  outcome: PiProcessOutcome,
  last: PiAssistantMessage | undefined,
  timeoutMs: number,
): HandlerOutcome => {
  switch (outcome.kind) {
    case 'settled':
      if (outcome.aborted) return { error: { code: 'cancelled', message: 'Pi aborted the run.' } };

      if (last === undefined) {
        return {
          error: { code: 'pi_no_output', message: 'Pi settled without an assistant message.' },
        };
      }

      if (last.stopReason === 'error' || last.stopReason === 'aborted') {
        return {
          error: {
            code: 'pi_agent_failed',
            message: last.errorMessage ?? `Pi stopped with stopReason ${last.stopReason}.`,
          },
        };
      }

      return { output: assistantText(last) };
    case 'handled':
      return {
        error: { code: 'pi_no_output', message: 'Pi handled the prompt without starting a run.' },
      };
    case 'rejected':
      return { error: { code: 'pi_prompt_rejected', message: outcome.message } };
    case 'exited':
      return { error: { code: 'pi_exited', message: describeExit(outcome) } };
    case 'spawn_failed':
      return { error: { code: 'pi_spawn_failed', message: outcome.message } };
    case 'protocol_error':
      return { error: { code: 'pi_protocol_error', message: outcome.message } };
    case 'timeout':
      return {
        error: { code: 'timeout', message: `Pi did not settle within ${String(timeoutMs)} ms.` },
      };
    case 'cancelled':
      return { error: { code: 'cancelled', message: 'The invocation was cancelled.' } };
  }
};

/**
 * Creates a handler that runs each invocation through `pi --mode rpc` in its own workspace. The
 * output is the text of Pi's last assistant message; the trace maps the run, its turns and its
 * tool calls; the artifacts are the workspace files whose SHA-256 changed during the run.
 */
const createPiHandler = ({
  argv = ['pi'],
  model,
  systemPrompt,
  workspace,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: PiHandlerOptions = {}): AgentHandler => {
  const command: [string, ...string[]] = [...argv, ...PI_RPC_FLAGS];

  if (model !== undefined) command.push('--model', model);

  if (systemPrompt !== undefined) command.push('--system-prompt', systemPrompt);

  return async (invocation, { signal }) => {
    const message = promptOf(invocation.input);

    if (message === undefined) {
      return {
        error: {
          code: 'invalid_input',
          message:
            'The Pi handler needs `input` to be a string or an object with a string `prompt`.',
        },
      };
    }

    const cwd =
      workspace === undefined
        ? await mkdtemp(join(tmpdir(), 'attest-pi-'))
        : await workspace(invocation);

    try {
      const before = await hashFiles(cwd);
      const trace = createPiTraceBuilder(model);
      let last: PiAssistantMessage | undefined;

      const outcome = await runPiProcess({
        argv: command,
        cwd,
        message,
        signal,
        timeoutMs,
        onRecord: (record) => {
          trace.record(record);

          if (record.type === 'message_end' && record.message !== null) last = record.message;
        },
      });

      const after = await hashFiles(cwd);

      const changed = new Set(
        [...after].flatMap(([path, hash]) => (before.get(path) === hash ? [] : [path])),
      );

      const collected = await collectArtifacts(cwd, { include: (path) => changed.has(path) });

      for (const skipped of collected.skipped) {
        trace.note('artifact_skipped', { path: skipped.path, reason: skipped.reason });
      }

      const result = outcomeOf(outcome, last, timeoutMs);

      return {
        ...result,
        artifacts: collected.artifacts,
        trace: trace.finish('error' in result ? result.error.message : undefined),
      };
    } finally {
      if (workspace === undefined) await rm(cwd, { recursive: true, force: true });
    }
  };
};

export { createPiHandler, type PiHandlerOptions };
