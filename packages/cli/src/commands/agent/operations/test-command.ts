import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { JsonValue } from '@attest/contracts';
import { openStore } from '@attest/core';

import { AttestCliError } from '../../../errors/index.js';
import { loadCommandProject } from '../../project/load-command-project.js';
import type { CommandResult } from '../../shared/command-result.js';
import { readAgentCommandRequest, type ReadInput } from '../agent-request.js';
import { testNativeAgentConnection } from '../native-agent-adapter.js';
import { assertNoFromJsonFlags, findAgent, promptRequired } from './command-support.js';
import type { AgentTestCommandOptions } from './types.js';

const readTestInput = async (
  input: string | undefined,
  inputFile: string | undefined,
  workingDirectory: string,
  readStdin: ReadInput,
): Promise<JsonValue> => {
  if (input !== undefined && inputFile !== undefined) {
    throw new AttestCliError('cli_usage', 'Agent test input sources overlap.', {
      path: '--input',
      hint: 'Pass either `--input` or `--input-file`, not both.',
    });
  }
  let text = input;
  if (inputFile !== undefined) {
    try {
      text =
        inputFile === '-'
          ? await readStdin()
          : await readFile(resolve(workingDirectory, inputFile), 'utf8');
    } catch (error: unknown) {
      throw new AttestCliError('cli_usage', 'Could not read agent test input.', {
        path: '--input-file',
        cause: error,
      });
    }
  }
  if (text === undefined) return {};
  try {
    return JSON.parse(text) as JsonValue;
  } catch (error: unknown) {
    throw new AttestCliError('cli_usage', 'Agent test input is not valid JSON.', {
      path: inputFile === undefined ? '--input' : '--input-file',
      hint: 'Pass any valid JSON scalar, array, or object.',
      cause: error,
    });
  }
};

/** Probes one supported adapter without project writes and records one case only when requested. */
const runAgentTestCommand = async (options: AgentTestCommandOptions): Promise<CommandResult> => {
  assertNoFromJsonFlags(options.fromJson, {
    'agent-id': options.agentId,
    input: options.input,
    'input-file': options.inputFile,
    record: options.record,
  });
  if (options.fromJson === '-' && options.inputFile === '-') {
    throw new AttestCliError('cli_usage', 'Command request and test input cannot share stdin.', {
      path: '--input-file',
    });
  }
  const request: { agent_id: string; input: JsonValue; record?: boolean } =
    options.fromJson === undefined
      ? {
          agent_id: await promptRequired(
            options.agentId,
            'Agent id',
            '<agent-id>',
            options.interactive,
            options.prompt,
            options.signal,
          ),
          input: await readTestInput(
            options.input,
            options.inputFile,
            options.workingDirectory,
            options.readStdin,
          ),
        }
      : await readAgentCommandRequest(
          options.fromJson,
          'agent.test',
          options.workingDirectory,
          options.readStdin,
        );
  const loaded = await loadCommandProject({
    project: options.project,
    workingDirectory: options.workingDirectory,
  });
  const agent = findAgent(loaded.agents, request.agent_id);
  const record = request.record ?? options.record ?? false;
  let store: Awaited<ReturnType<typeof openStore>> | undefined;
  let runId: string | undefined;
  if (record) {
    await mkdir(join(loaded.root, '.attest'), { recursive: true });
    store = await openStore(join(loaded.root, '.attest', 'runs.db'));
    const run = await store.runs.createRun({
      schemaId: 'attest.agent-test',
      configHash: loaded.projectHash,
      configJson: JSON.stringify({ agent_id: agent.id, project_hash: loaded.projectHash }),
      labels: { agent_id: agent.id, kind: 'agent-probe' },
    });
    runId = run.id;
  }
  let result: JsonValue;
  try {
    result = await testNativeAgentConnection({
      agent,
      input: request.input,
      onExecution:
        store === undefined || runId === undefined
          ? undefined
          : (execution) => store.runs.recordCase(runId, execution, []),
      onProgress: options.watch === true ? options.onProgress : undefined,
      projectRoot: loaded.root,
      runId,
      signal: options.signal,
    });
    if (store !== undefined && runId !== undefined) {
      await store.runs.finalizeRun(runId, 'completed');
    }
  } catch (error: unknown) {
    if (store !== undefined && runId !== undefined) {
      await store.runs.finalizeRun(
        runId,
        error instanceof AttestCliError && error.code === 'cancelled' ? 'cancelled' : 'failed',
      );
    }
    throw error;
  } finally {
    await store?.close();
  }
  const resultWithRecord =
    runId === undefined
      ? result
      : ({ ...(result as Record<string, JsonValue>), recorded_run_id: runId } as JsonValue);
  return {
    human: `Agent ${agent.id} passed the connection test.${runId === undefined ? '' : `\nRecorded run: ${runId}`}`,
    projectHashAfter: loaded.projectHash,
    projectHashBefore: loaded.projectHash,
    result: resultWithRecord,
  };
};

export { runAgentTestCommand };
