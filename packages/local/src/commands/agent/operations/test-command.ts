import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { JsonValue } from '@attest/contracts';
import type { StoredCaseExecution } from '@attest/core';

import { LocalError } from '../../../errors/index.js';
import { parseJsonText, readSourceText } from '../../../internal/source-text.js';
import { openStore } from '../../../store/index.js';
import { loadCommandProject } from '../../project/load-command-project.js';
import type { AgentTestResult, CommandResult } from '../../shared/command-result.js';
import type { ReadInput } from '../authoring/index.js';
import { testNativeAgentConnection } from '../native-agent-adapter/index.js';
import { findAgent } from './agent-mutation.js';
import type { AgentTestCommandOptions } from './types.js';

type AgentTestInputOptions = {
  input?: string;
  inputFile?: string;
  readStdin: ReadInput;
  workingDirectory: string;
};

/** Reads the probe input from `--input` or `--input-file`; with neither, the input is `{}`. */
const readAgentTestInput = async (options: AgentTestInputOptions): Promise<JsonValue> => {
  if (options.input !== undefined && options.inputFile !== undefined) {
    throw new LocalError('cli_usage', 'Agent test input sources overlap.', {
      path: '--input',
      hint: 'Pass either `--input` or `--input-file`, not both.',
    });
  }
  const hint = 'Pass any valid JSON scalar, array, or object.';
  if (options.inputFile !== undefined) {
    const text = await readSourceText(options.inputFile, {
      path: '--input-file',
      readStdin: options.readStdin,
      workingDirectory: options.workingDirectory,
    });
    return parseJsonText(text, { path: '--input-file', hint });
  }
  if (options.input === undefined) return {};
  return parseJsonText(options.input, { path: '--input', hint });
};

type ProbeRecording = {
  finish: (status: 'cancelled' | 'completed' | 'failed') => Promise<void>;
  record: (execution: StoredCaseExecution) => Promise<void>;
  runId: string;
};

/** Opens the project run store and one run that captures a single probe case. */
const startProbeRecording = async (
  root: string,
  agentId: string,
  projectHash: string,
): Promise<ProbeRecording> => {
  await mkdir(join(root, '.attest'), { recursive: true });
  const store = await openStore(join(root, '.attest', 'runs.db'));
  const run = await store.runs.createRun({
    schemaId: 'attest.agent-test',
    configHash: projectHash,
    configJson: JSON.stringify({ agent_id: agentId, project_hash: projectHash }),
    labels: { agent_id: agentId, kind: 'agent-probe' },
  });
  return {
    finish: async (status) => {
      try {
        await store.runs.finalizeRun(run.id, status);
      } finally {
        await store.close();
      }
    },
    record: (execution) => store.runs.recordCase(run.id, execution, []),
    runId: run.id,
  };
};

/** Probes one supported adapter without project writes and records one case only when requested. */
const runAgentTestCommand = async (
  options: AgentTestCommandOptions,
): Promise<CommandResult<'agent-test', AgentTestResult>> => {
  const { request } = options;
  const loaded = await loadCommandProject({
    project: options.project,
    workingDirectory: options.workingDirectory,
  });
  const agent = findAgent(loaded.agents, request.agent_id);
  const recording =
    request.record === true
      ? await startProbeRecording(loaded.root, agent.id, loaded.projectHash)
      : undefined;
  let result: Awaited<ReturnType<typeof testNativeAgentConnection>>;
  try {
    result = await testNativeAgentConnection({
      agent,
      input: request.input,
      onExecution: recording?.record,
      onProgress: options.watch === true ? options.onProgress : undefined,
      projectRoot: loaded.root,
      runId: recording?.runId,
      signal: options.signal,
    });
  } catch (error: unknown) {
    const cancelled = error instanceof LocalError && error.code === 'cancelled';
    await recording?.finish(cancelled ? 'cancelled' : 'failed');
    throw error;
  }
  await recording?.finish('completed');
  return {
    operation: 'agent-test',
    projectHashAfter: loaded.projectHash,
    projectHashBefore: loaded.projectHash,
    result: recording === undefined ? result : { ...result, recorded_run_id: recording.runId },
  };
};

export { readAgentTestInput, runAgentTestCommand };
