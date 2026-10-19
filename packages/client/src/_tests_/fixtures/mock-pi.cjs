#!/usr/bin/env node
'use strict';

/**
 * A fake `pi --mode rpc` speaking the subset of the Pi 1.3 RPC protocol the handler uses. Record
 * shapes follow Pi's docs/json.md, docs/rpc.md and docs/message-types.md. A prompt runs two turns:
 * the first calls the `write` tool, which really writes `answer.ts` into the working directory;
 * the second answers "Wrote answer.ts". Like real Pi it reads LF-framed JSON from stdin and exits
 * when stdin closes.
 *
 * Environment:
 * - MOCK_PI_DELAY_MS: pause before each record, so tests can abort mid-run.
 * - MOCK_PI_FAIL=1: the first turn ends with a provider error and no tool call.
 * - MOCK_PI_PID_FILE: write this process's pid there on start.
 */

const fs = process.getBuiltinModule('node:fs');

const path = process.getBuiltinModule('node:path');

const delayMs = Math.max(0, Number(process.env.MOCK_PI_DELAY_MS || 0));

const usage = {
  input: 12,
  output: 4,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 16,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let run;

if (process.env.MOCK_PI_PID_FILE)
  fs.writeFileSync(process.env.MOCK_PI_PID_FILE, String(process.pid));

const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);

const sleep = () => new Promise((resolve) => setTimeout(resolve, delayMs));

const assistant = (content, stopReason, extra = {}) => ({
  role: 'assistant',
  content,
  api: 'mock',
  provider: 'mock',
  model: 'mock/pi-1',
  usage,
  stopReason,
  timestamp: Date.now(),
  ...extra,
});

/** Streams one assistant message: start, text deltas, end. */
async function* streamAssistant(message) {
  yield { type: 'message_start', message: { ...message, content: [], stopReason: 'pending' } };
  const text = message.content.find((block) => block.type === 'text');

  if (text) {
    yield {
      type: 'message_update',
      usage,
      assistantMessageEvent: { type: 'text_start', contentIndex: 0 },
    };

    for (const delta of text.text.match(/.{1,6}/gsu)) {
      yield {
        type: 'message_update',
        usage,
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta },
      };
    }

    yield {
      type: 'message_update',
      usage,
      assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: text.text },
    };
  }

  yield { type: 'message_end', message };
}

async function* events(prompt) {
  const user = { role: 'user', content: prompt, timestamp: Date.now() };

  yield { type: 'agent_start' };
  yield { type: 'turn_start' };
  yield { type: 'message_start', message: user };
  yield { type: 'message_end', message: user };

  if (process.env.MOCK_PI_FAIL === '1') {
    const failed = assistant([], 'error', { errorMessage: 'MOCK_PI_FAIL requested' });

    yield* streamAssistant(failed);
    yield { type: 'turn_end', message: failed, toolResults: [] };
    yield { type: 'agent_end', messages: [user, failed], willRetry: false };

    return;
  }

  const args = { path: 'answer.ts', content: 'export const answer = 42;\n' };

  const call = assistant(
    [
      { type: 'text', text: 'Writing answer.ts.' },
      { type: 'toolCall', id: 'call_write_1', name: 'write', arguments: args },
    ],
    'toolUse',
  );

  yield* streamAssistant(call);
  yield { type: 'tool_execution_start', toolCallId: 'call_write_1', toolName: 'write', args };
  const started = Date.now();

  fs.writeFileSync(path.join(process.cwd(), args.path), args.content, 'utf8');
  const result = { content: [{ type: 'text', text: 'Wrote answer.ts' }], details: {} };

  yield {
    type: 'tool_execution_end',
    toolCallId: 'call_write_1',
    toolName: 'write',
    result,
    isError: false,
    durationMs: Date.now() - started,
  };

  const toolResult = {
    role: 'toolResult',
    toolCallId: 'call_write_1',
    toolName: 'write',
    content: result.content,
    details: {},
    isError: false,
    timestamp: Date.now(),
  };

  yield { type: 'message_start', message: toolResult };
  yield { type: 'message_end', message: toolResult };
  yield { type: 'turn_end', message: call, toolResults: [toolResult] };
  yield { type: 'turn_start' };
  const answer = assistant([{ type: 'text', text: 'Wrote answer.ts' }], 'stop');

  yield* streamAssistant(answer);
  yield { type: 'turn_end', message: answer, toolResults: [] };
  yield { type: 'agent_end', messages: [user, call, toolResult, answer], willRetry: false };
}

async function start(prompt) {
  const current = { aborted: false };

  run = current;

  for await (const record of events(prompt)) {
    await sleep();

    if (current.aborted) return;
    emit(record);
  }

  emit({ type: 'agent_settled', aborted: false });
  run = undefined;
}

function handle(command) {
  if (command.type === 'prompt') {
    if (run) {
      emit({
        id: command.id,
        type: 'response',
        command: 'prompt',
        success: false,
        error: 'Agent is streaming; specify streamingBehavior',
      });

      return;
    }

    emit({
      id: command.id,
      type: 'response',
      command: 'prompt',
      success: true,
      data: { disposition: 'started' },
    });
    void start(command.message);
  } else if (command.type === 'abort') {
    if (run) {
      run.aborted = true;
      run = undefined;
      emit({ type: 'agent_end', messages: [], willRetry: false });
      emit({ type: 'agent_settled', aborted: true });
    }

    emit({ id: command.id, type: 'response', command: 'abort', success: true });
  } else {
    emit({
      id: command.id,
      type: 'response',
      command: command.type,
      success: false,
      error: `Unknown command: ${command.type}`,
    });
  }
}

let input = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk]);

  for (let lf = input.indexOf(10); lf !== -1; lf = input.indexOf(10)) {
    const line = input.subarray(0, lf).toString('utf8').replace(/\r$/u, '');

    input = input.subarray(lf + 1);

    if (line.trim() === '') continue;

    try {
      handle(JSON.parse(line));
    } catch (error) {
      emit({
        type: 'response',
        command: 'parse',
        success: false,
        error: `Failed to parse command: ${error.message}`,
      });
    }
  }
});

process.stdin.on('end', () => process.exit(0));
