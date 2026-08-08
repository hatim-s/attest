import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  type AgentResource,
  type CommandRequest,
  type JsonValue,
  type ProjectResources,
} from '@attest/contracts';

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
  project?: string;
  prompt?: Prompt;
  readStdin: ReadInput;
  signal?: AbortSignal;
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
): Promise<string> => {
  if (value?.trim()) return value.trim();
  if (interactive && prompt !== undefined) {
    const answer = (await prompt(`${label}: `)).trim();
    if (answer.length > 0) return answer;
  }
  throw new AttestCliError('cli_missing_input', `${label} is required.`, {
    path,
    hint: `Pass ${path} or a complete \`--from-json\` request.`,
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
): Promise<CommandResult> => {
  const result = await applyProjectMutation(
    {
      candidate,
      dryRun: request.dry_run,
      expectedProjectHash: request.if_project_hash,
      projectRoot: loaded.root,
      renames,
      warnings,
    },
    { publishObserver },
  );
  const verb = request.dry_run === true ? 'would apply' : 'applied';
  return {
    human: `${command} ${verb} ${result.diff.operations.length} operation(s).\nProject hash: ${result.projectHashAfter}`,
    projectHashAfter: result.projectHashAfter,
    projectHashBefore: result.projectHashBefore,
    result: {
      committed: result.committed,
      dry_run: request.dry_run === true,
      operations: result.diff.operations as unknown as JsonValue,
      warnings: result.diff.warnings as unknown as JsonValue,
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
  return mutationResult('agent.add', loaded, candidate, request, options.publishObserver);
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
    '<path|->',
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
  return mutationResult('agent.rename', loaded, candidate, request, options.publishObserver, [
    { from: request.agent_id, to: request.new_id, type: 'agent' },
  ]);
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

/** Probes one native adapter without mutating the project or creating an eval run. */
const runAgentTestCommand = async (options: AgentTestCommandOptions): Promise<CommandResult> => {
  assertNoFromJsonFlags(options.fromJson, {
    'agent-id': options.agentId,
    input: options.input,
    'input-file': options.inputFile,
  });
  if (options.fromJson === '-' && options.inputFile === '-') {
    throw new AttestCliError('cli_usage', 'Command request and test input cannot share stdin.', {
      path: '--input-file',
    });
  }
  const request =
    options.fromJson === undefined
      ? {
          agent_id: await promptRequired(
            options.agentId,
            'Agent id',
            '<agent-id>',
            options.interactive,
            options.prompt,
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
  const result = await testNativeAgentConnection({
    agent,
    input: request.input,
    projectRoot: loaded.root,
    signal: options.signal,
  });
  return {
    human: `Agent ${agent.id} passed the native connection test.`,
    projectHashAfter: loaded.projectHash,
    projectHashBefore: loaded.projectHash,
    result,
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
