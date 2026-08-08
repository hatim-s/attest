import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  type AgentResource,
  type CommandRequest,
  type JsonValue,
  type ProjectResources,
} from '@attest/contracts';
import { openStore } from '@attest/core';

import { AttestCliError } from '../../errors.js';
import { applyProjectMutation, type PublishObserver } from '../../project/transaction/index.js';
import type { CommandResult } from '../command-result.js';
import { loadCommandProject } from '../project/load-command-project.js';
import {
  assertSafeNativeAgentResource,
  createAgentResource,
  readAgentCommandRequest,
  readImportedAgentResource,
  type ReadInput,
} from './agent-request.js';
import { testNativeAgentConnection } from './native-agent-adapter.js';

type Prompt = (question: string) => Promise<string>;

type MutationFields = {
  dryRun?: boolean;
  expectedProjectHash?: string;
  fromJson?: string;
  project?: string;
  publishObserver?: PublishObserver;
  readStdin: ReadInput;
  workingDirectory: string;
  yes?: boolean;
};

type AgentAddCommandOptions = MutationFields & {
  agentId?: string;
  argvJson?: string;
  env?: readonly string[];
  headerEnv?: readonly string[];
  interactive: boolean;
  name?: string;
  nativeCommand?: string;
  nativeHttp?: string;
  prompt?: Prompt;
  timeout?: string;
  trace?: boolean;
};

type AgentImportCommandOptions = MutationFields & {
  agentId?: string;
  interactive: boolean;
  name?: string;
  prompt?: Prompt;
  source?: string;
  sourceType?: string;
};

type AgentRenameCommandOptions = MutationFields & {
  agentId?: string;
  interactive: boolean;
  newId?: string;
  prompt?: Prompt;
};

type AgentRemoveCommandOptions = MutationFields & {
  agentId?: string;
  detach?: boolean;
  interactive: boolean;
  prompt?: Prompt;
};

type AgentTestCommandOptions = {
  agentId?: string;
  fromJson?: string;
  input?: string;
  inputFile?: string;
  interactive: boolean;
  onProgress?: (message: string) => void;
  project?: string;
  prompt?: Prompt;
  readStdin: ReadInput;
  signal?: AbortSignal;
  watch?: boolean;
  record?: boolean;
  workingDirectory: string;
};

type AgentMutationRequest = Extract<
  CommandRequest,
  { command: 'agent.add' | 'agent.import' | 'agent.remove' | 'agent.rename' }
>;

const candidateFromLoaded = (
  loaded: Awaited<ReturnType<typeof loadCommandProject>>,
): ProjectResources =>
  structuredClone({
    agents: loaded.agents,
    datasets: loaded.datasets,
    metrics: loaded.metrics,
    project: loaded.project,
    tests: loaded.tests,
  });

const promptRequired = async (
  value: string | undefined,
  label: string,
  path: string,
  interactive: boolean,
  prompt: Prompt | undefined,
  signal?: AbortSignal,
): Promise<string> => {
  if (signal?.aborted === true) throw new AttestCliError('cancelled', 'Command cancelled.');
  if (value?.trim()) return value.trim();
  if (interactive && prompt !== undefined) {
    const answer = (await promptWithSignal(prompt, `${label}: `, signal)).trim();
    if (answer.length > 0) return answer;
  }
  throw new AttestCliError('cli_missing_input', `${label} is required.`, {
    path,
    hint: `Pass ${path} or a complete \`--from-json\` request.`,
  });
};

/** Makes every guided prompt terminate promptly when the command is cancelled. */
const promptWithSignal = async (
  prompt: Prompt,
  question: string,
  signal?: AbortSignal,
): Promise<string> => {
  if (signal === undefined) return prompt(question);
  if (signal.aborted) throw new AttestCliError('cancelled', 'Command cancelled.');
  return new Promise<string>((resolvePrompt, rejectPrompt) => {
    const cancel = (): void => rejectPrompt(new AttestCliError('cancelled', 'Command cancelled.'));
    signal.addEventListener('abort', cancel, { once: true });
    void prompt(question)
      .then(resolvePrompt, rejectPrompt)
      .finally(() => {
        signal.removeEventListener('abort', cancel);
      });
  });
};

const assertNoFromJsonFlags = (
  fromJson: string | undefined,
  fields: Readonly<Record<string, unknown>>,
): void => {
  if (fromJson === undefined) return;
  const conflicts = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== false)
    .map(([name]) => name)
    .sort();
  if (conflicts.length === 0) return;
  throw new AttestCliError('cli_usage', 'Command request input overlaps with CLI values.', {
    path: '--from-json',
    hint: 'Pass command values in either the request document or flags, not both.',
    details: { conflicting_fields: conflicts },
  });
};

const findAgent = (agents: readonly AgentResource[], id: string): AgentResource => {
  const agent = agents.find((candidate) => candidate.id === id);
  if (agent === undefined) {
    throw new AttestCliError('resource_not_found', `Agent ${id} does not exist.`, {
      path: id,
      hint: 'Run `attest list agents` and retry with an available id.',
    });
  }
  return agent;
};

const mutationResult = async (
  command: string,
  loaded: Awaited<ReturnType<typeof loadCommandProject>>,
  candidate: ProjectResources,
  request: Pick<AgentMutationRequest, 'dry_run' | 'if_project_hash'>,
  publishObserver?: PublishObserver,
  renames?: readonly { from: string; to: string; type: 'agent' }[],
  warnings?: readonly string[],
  confirmation?: {
    interactive: boolean;
    nextCommand?: string;
    prompt?: Prompt;
    requireExplicit: boolean;
    yes?: boolean;
  },
): Promise<CommandResult> => {
  const apply = (dryRun: boolean) =>
    applyProjectMutation(
      {
        candidate,
        dryRun,
        expectedProjectHash: request.if_project_hash,
        projectRoot: loaded.root,
        renames,
        warnings,
      },
      { publishObserver },
    );
  const preview = await apply(true);
  const operationLines = preview.diff.operations.map((operation) => {
    const renamed = operation.previous_id === undefined ? '' : ` from ${operation.previous_id}`;
    const changes = operation.changes.map(({ path }) => path).join(', ');
    const references = [
      ...operation.references_added.map(({ id }) => `+ref:${id}`),
      ...operation.references_removed.map(({ id }) => `-ref:${id}`),
    ].join(', ');
    const details = [changes, references].filter((value) => value.length > 0).join('; ');
    return `- ${operation.op} ${operation.resource.type} ${operation.resource.id}${renamed}${details.length === 0 ? '' : ` (${details})`}`;
  });
  const warningLines = preview.diff.warnings.map((warning) => `Warning: ${warning}`);
  const previewText = [
    `${command} ${request.dry_run === true ? 'preview' : 'changes'}:`,
    ...(operationLines.length === 0 ? ['- no semantic changes'] : operationLines),
    ...warningLines,
  ].join('\n');
  if (request.dry_run !== true && confirmation?.yes !== true) {
    if (confirmation?.interactive === true && confirmation.prompt !== undefined) {
      const answer = (
        await confirmation.prompt(`${previewText}\nApply these changes? [y/N]: `)
      ).trim();
      if (!/^y(?:es)?$/iu.test(answer)) {
        throw new AttestCliError('cancelled', 'Project mutation was not confirmed.');
      }
    } else if (confirmation?.requireExplicit === true) {
      throw new AttestCliError('cli_usage', 'This destructive mutation requires confirmation.', {
        path: '--yes',
        hint: 'Review `--dry-run --output json`, then pass `--yes` to apply the exact cascade.',
        details: { operations: preview.diff.operations as unknown as JsonValue },
      });
    }
  }
  const result = request.dry_run === true ? preview : await apply(false);
  const verb = request.dry_run === true ? 'would apply' : 'applied';
  const next =
    request.dry_run === true || confirmation?.nextCommand === undefined
      ? ''
      : `\nNext: ${confirmation.nextCommand}`;
  return {
    human: `${previewText}\n${command} ${verb} ${result.diff.operations.length} operation(s).\nProject hash: ${result.projectHashAfter}${next}`,
    projectHashAfter: result.projectHashAfter,
    projectHashBefore: result.projectHashBefore,
    result: {
      committed: result.committed,
      dry_run: request.dry_run === true,
      operations: result.diff.operations as unknown as JsonValue,
      warnings: result.diff.warnings as unknown as JsonValue,
      ...(request.dry_run === true || confirmation?.nextCommand === undefined
        ? {}
        : { next_command: confirmation.nextCommand }),
    },
  };
};

/** Adds one native agent resource through the shared transactional project writer. */
const runAgentAddCommand = async (options: AgentAddCommandOptions): Promise<CommandResult> => {
  assertNoFromJsonFlags(options.fromJson, {
    'agent-id': options.agentId,
    'argv-json': options.argvJson,
    env: options.env,
    'header-env': options.headerEnv,
    name: options.name,
    'native-command': options.nativeCommand,
    'native-http': options.nativeHttp,
    timeout: options.timeout,
    trace: options.trace,
    'dry-run': options.dryRun,
    'if-project-hash': options.expectedProjectHash,
    yes: options.yes,
  });
  let request: Extract<CommandRequest, { command: 'agent.add' }>;
  if (options.fromJson !== undefined) {
    request = await readAgentCommandRequest(
      options.fromJson,
      'agent.add',
      options.workingDirectory,
      options.readStdin,
    );
  } else {
    const agentId = await promptRequired(
      options.agentId,
      'Agent id',
      '<agent-id>',
      options.interactive,
      options.prompt,
    );
    let nativeCommand = options.nativeCommand;
    let nativeHttp = options.nativeHttp;
    if (
      options.argvJson === undefined &&
      nativeCommand === undefined &&
      nativeHttp === undefined &&
      options.interactive
    ) {
      const transport = (await options.prompt?.('Transport [cli/http]: '))?.trim().toLowerCase();
      if (transport === 'http') {
        nativeHttp = await promptRequired(
          undefined,
          'Native HTTP URL',
          '--native-http',
          true,
          options.prompt,
        );
      } else if (transport === '' || transport === 'cli' || transport === undefined) {
        nativeCommand = await promptRequired(
          undefined,
          'Native command',
          '--native-command',
          true,
          options.prompt,
        );
      } else {
        throw new AttestCliError('cli_usage', 'Transport must be cli or http.', {
          path: 'transport',
        });
      }
    }
    request = {
      schema: 'attest.command-request/v2',
      command: 'agent.add',
      agent: createAgentResource({
        agentId,
        argvJson: options.argvJson,
        env: options.env,
        headerEnv: options.headerEnv,
        name: options.name,
        nativeCommand,
        nativeHttp,
        timeout: options.timeout,
        trace: options.trace,
      }),
      ...(options.dryRun === undefined ? {} : { dry_run: options.dryRun }),
      ...(options.expectedProjectHash === undefined
        ? {}
        : { if_project_hash: options.expectedProjectHash }),
      ...(options.yes === undefined ? {} : { yes: options.yes }),
    };
  }
  assertSafeNativeAgentResource(request.agent);
  const loaded = await loadCommandProject({
    project: options.project,
    recover: request.dry_run !== true,
    workingDirectory: options.workingDirectory,
  });
  if (loaded.agents.some(({ id }) => id === request.agent.id)) {
    throw new AttestCliError('project_invalid', `Agent ${request.agent.id} already exists.`, {
      path: request.agent.id,
      hint: 'Choose another id or remove the existing agent first.',
    });
  }
  const candidate = candidateFromLoaded(loaded);
  candidate.agents.push(request.agent);
  return mutationResult(
    'agent.add',
    loaded,
    candidate,
    request,
    options.publishObserver,
    undefined,
    undefined,
    {
      interactive: options.interactive,
      nextCommand: `attest agent test ${request.agent.id}`,
      prompt: options.prompt,
      requireExplicit: false,
      yes: request.yes,
    },
  );
};

/** Imports one canonical JSON native agent resource without retaining its source contents. */
const runAgentImportCommand = async (
  options: AgentImportCommandOptions,
): Promise<CommandResult> => {
  assertNoFromJsonFlags(options.fromJson, {
    'agent-id': options.agentId,
    name: options.name,
    source: options.source,
    type: options.sourceType,
    'dry-run': options.dryRun,
    'if-project-hash': options.expectedProjectHash,
    yes: options.yes,
  });
  let source = options.source;
  let agentId = options.agentId;
  let name = options.name;
  let request: Extract<CommandRequest, { command: 'agent.import' }> | undefined;
  if (options.fromJson !== undefined) {
    request = await readAgentCommandRequest(
      options.fromJson,
      'agent.import',
      options.workingDirectory,
      options.readStdin,
    );
    if (request.source_type !== 'json') {
      throw new AttestCliError('cli_usage', 'cURL import belongs to CLI2.10.', {
        path: '/source_type',
        hint: 'Import one canonical JSON native agent resource in CLI2.6.',
      });
    }
    if (options.fromJson === '-' && request.source === '-') {
      throw new AttestCliError(
        'cli_usage',
        'Command request and agent source cannot share stdin.',
        {
          path: '/source',
          hint: 'Put either the request document or imported resource in a file.',
        },
      );
    }
    source = request.source;
    agentId = request.as;
    name = request.name;
  }
  if (options.sourceType !== undefined && options.sourceType !== 'json') {
    throw new AttestCliError('cli_usage', 'Only JSON native-agent import is available in CLI2.6.', {
      path: '--type',
      hint: 'Use `--type json`; cURL mapping lands in CLI2.10.',
    });
  }
  source = await promptRequired(
    source,
    'Agent JSON source',
    '<path|url|->',
    options.interactive,
    options.prompt,
  );
  agentId = await promptRequired(
    agentId,
    'Imported agent id',
    '--as',
    options.interactive,
    options.prompt,
  );
  const agent = await readImportedAgentResource(
    source,
    agentId,
    name,
    options.workingDirectory,
    options.readStdin,
  );
  const loaded = await loadCommandProject({
    project: options.project,
    recover: (request?.dry_run ?? options.dryRun) !== true,
    workingDirectory: options.workingDirectory,
  });
  if (loaded.agents.some(({ id }) => id === agent.id)) {
    throw new AttestCliError('project_invalid', `Agent ${agent.id} already exists.`, {
      path: agent.id,
    });
  }
  const candidate = candidateFromLoaded(loaded);
  candidate.agents.push(agent);
  return mutationResult(
    'agent.import',
    loaded,
    candidate,
    {
      dry_run: request?.dry_run ?? options.dryRun,
      if_project_hash: request?.if_project_hash ?? options.expectedProjectHash,
    },
    options.publishObserver,
    undefined,
    undefined,
    {
      interactive: options.interactive,
      nextCommand: `attest agent test ${agent.id}`,
      prompt: options.prompt,
      requireExplicit: false,
      yes: request?.yes ?? options.yes,
    },
  );
};

/** Renames an agent and every test reference in one atomic transaction. */
const runAgentRenameCommand = async (
  options: AgentRenameCommandOptions,
): Promise<CommandResult> => {
  assertNoFromJsonFlags(options.fromJson, {
    'agent-id': options.agentId,
    'new-id': options.newId,
    'dry-run': options.dryRun,
    'if-project-hash': options.expectedProjectHash,
    yes: options.yes,
  });
  const request =
    options.fromJson === undefined
      ? {
          schema: 'attest.command-request/v2' as const,
          command: 'agent.rename' as const,
          agent_id: await promptRequired(
            options.agentId,
            'Agent id',
            '<agent-id>',
            options.interactive,
            options.prompt,
          ),
          new_id: await promptRequired(
            options.newId,
            'New agent id',
            '<new-id>',
            options.interactive,
            options.prompt,
          ),
          ...(options.dryRun === undefined ? {} : { dry_run: options.dryRun }),
          ...(options.expectedProjectHash === undefined
            ? {}
            : { if_project_hash: options.expectedProjectHash }),
          ...(options.yes === undefined ? {} : { yes: options.yes }),
        }
      : await readAgentCommandRequest(
          options.fromJson,
          'agent.rename',
          options.workingDirectory,
          options.readStdin,
        );
  const loaded = await loadCommandProject({
    project: options.project,
    recover: request.dry_run !== true,
    workingDirectory: options.workingDirectory,
  });
  const current = findAgent(loaded.agents, request.agent_id);
  if (loaded.agents.some(({ id }) => id === request.new_id)) {
    throw new AttestCliError('project_invalid', `Agent ${request.new_id} already exists.`, {
      path: request.new_id,
    });
  }
  const candidate = candidateFromLoaded(loaded);
  candidate.agents = candidate.agents.map((agent) =>
    agent.id === current.id ? { ...agent, id: request.new_id } : agent,
  );
  candidate.tests = candidate.tests.map((test) =>
    test.agent_id === current.id ? { ...test, agent_id: request.new_id } : test,
  );
  return mutationResult(
    'agent.rename',
    loaded,
    candidate,
    request,
    options.publishObserver,
    [{ from: request.agent_id, to: request.new_id, type: 'agent' }],
    undefined,
    {
      interactive: options.interactive,
      nextCommand: `attest agent test ${request.new_id}`,
      prompt: options.prompt,
      requireExplicit: false,
      yes: request.yes,
    },
  );
};

/** Removes an unreferenced agent, or explicitly cascades dependent tests with --detach. */
const runAgentRemoveCommand = async (
  options: AgentRemoveCommandOptions,
): Promise<CommandResult> => {
  assertNoFromJsonFlags(options.fromJson, {
    'agent-id': options.agentId,
    detach: options.detach,
    'dry-run': options.dryRun,
    'if-project-hash': options.expectedProjectHash,
    yes: options.yes,
  });
  const request =
    options.fromJson === undefined
      ? {
          schema: 'attest.command-request/v2' as const,
          command: 'agent.remove' as const,
          agent_id: await promptRequired(
            options.agentId,
            'Agent id',
            '<agent-id>',
            options.interactive,
            options.prompt,
          ),
          ...(options.detach === undefined ? {} : { detach: options.detach }),
          ...(options.dryRun === undefined ? {} : { dry_run: options.dryRun }),
          ...(options.expectedProjectHash === undefined
            ? {}
            : { if_project_hash: options.expectedProjectHash }),
          ...(options.yes === undefined ? {} : { yes: options.yes }),
        }
      : await readAgentCommandRequest(
          options.fromJson,
          'agent.remove',
          options.workingDirectory,
          options.readStdin,
        );
  const loaded = await loadCommandProject({
    project: options.project,
    recover: request.dry_run !== true,
    workingDirectory: options.workingDirectory,
  });
  findAgent(loaded.agents, request.agent_id);
  const dependentTests = loaded.tests.filter(
    ({ agent_id: agentId }) => agentId === request.agent_id,
  );
  if (dependentTests.length > 0 && request.detach !== true) {
    throw new AttestCliError('project_invalid', 'Agent is referenced by tests.', {
      path: request.agent_id,
      hint: 'Rename the reference, remove the dependent tests, or pass `--detach` to cascade them.',
      details: { dependent_test_ids: dependentTests.map(({ id }) => id) },
    });
  }
  const candidate = candidateFromLoaded(loaded);
  candidate.agents = candidate.agents.filter(({ id }) => id !== request.agent_id);
  candidate.tests = candidate.tests.filter(({ agent_id: agentId }) => agentId !== request.agent_id);
  const warnings =
    dependentTests.length === 0
      ? []
      : [`Removed dependent tests: ${dependentTests.map(({ id }) => id).join(', ')}`];
  return mutationResult(
    'agent.remove',
    loaded,
    candidate,
    request,
    options.publishObserver,
    undefined,
    warnings,
    {
      interactive: options.interactive,
      prompt: options.prompt,
      requireExplicit: dependentTests.length > 0,
      yes: request.yes,
    },
  );
};

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

/** Probes one native adapter without project writes and records one case only when requested. */
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
      configVersion: 'attest.agent-test/v1',
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
    human: `Agent ${agent.id} passed the native connection test.${runId === undefined ? '' : `\nRecorded run: ${runId}`}`,
    projectHashAfter: loaded.projectHash,
    projectHashBefore: loaded.projectHash,
    result: resultWithRecord,
  };
};

export {
  runAgentAddCommand,
  runAgentImportCommand,
  runAgentRemoveCommand,
  runAgentRenameCommand,
  runAgentTestCommand,
  type AgentAddCommandOptions,
  type AgentImportCommandOptions,
  type AgentRemoveCommandOptions,
  type AgentRenameCommandOptions,
  type AgentTestCommandOptions,
};
