import { valueFromExit } from '../../../internal/effect-exit.js';
import * as Effect from 'effect/Effect';
import { COMMAND_REQUEST_SCHEMA_ID, type AgentResource } from '@attest/contracts';
import { describe, expect, it } from 'vitest';

import { loadProject } from '../../../project/index.js';
import {
  candidateFromLoadedProject,
  loadCommandProject,
} from '../../project/load-command-project.js';
import type { Prompt } from '../../shared/prompt.js';
import { runAgentAddCommand } from '../add.js';
import { mutationResult } from '../agent-mutation.js';
import { runAgentRemoveCommand } from '../remove.js';
import { addAgent, createAgentProject } from './support/agent-project.js';

const agent = (id: string): AgentResource => ({
  schema: 'attest.agent',
  id,
  name: id,
  transport: { kind: 'native_cli', lifecycle: 'per_case', argv: ['node', 'agent.mjs'] },
});

const projectChanged = {
  code: 'project_changed',
  hint: 'Read the current project hash, rebuild the candidate, and retry.',
};

describe('agent mutation confirmation', () => {
  it('rejects a project change that lands while the confirmation prompt is open', async () => {
    const root = await createAgentProject();

    const addWhilePrompting =
      (expectedLine: string, racer: string): Prompt =>
      (question) =>
        Effect.promise(async () => {
          expect(question).toContain(expectedLine);
          await addAgent(root, agent(racer));

          return 'yes';
        });

    const add = Effect.runPromiseExit(
      runAgentAddCommand({
        interactive: true,
        project: root,
        prompt: addWhilePrompting('- add agent previewed', 'racer'),
        request: {
          schema: COMMAND_REQUEST_SCHEMA_ID,
          command: 'agent.add',
          agent: agent('previewed'),
        },
        workingDirectory: root,
      }),
    ).then((exit) => valueFromExit(exit));

    await expect(add).rejects.toMatchObject(projectChanged);

    const remove = Effect.runPromiseExit(
      runAgentRemoveCommand({
        interactive: true,
        project: root,
        prompt: addWhilePrompting('- remove test refund', 'concurrent'),
        request: {
          schema: COMMAND_REQUEST_SCHEMA_ID,
          command: 'agent.remove',
          agent_id: 'support',
          detach: true,
        },
        workingDirectory: root,
      }),
    ).then((exit) => valueFromExit(exit));

    await expect(remove).rejects.toMatchObject(projectChanged);

    const loaded = await Effect.runPromiseExit(loadProject({ project: root })).then((exit) =>
      valueFromExit(exit),
    );

    expect(loaded.agents.map(({ id }) => id)).toEqual(['concurrent', 'racer', 'support']);
    expect(loaded.tests).toMatchObject([{ id: 'refund', agent_id: 'support' }]);
  });

  it('rejects a write that lands between loading the project and previewing the mutation', async () => {
    const root = await createAgentProject();

    const loaded = await Effect.runPromiseExit(
      loadCommandProject({ project: root, workingDirectory: root }),
    ).then((exit) => valueFromExit(exit));

    let candidate = candidateFromLoadedProject(loaded);
    candidate = { ...candidate, agents: [...candidate.agents, agent('stale')] };
    await addAgent(root, agent('racer'));

    const commit = Effect.runPromiseExit(
      mutationResult({
        candidate,
        command: 'agent.add',
        confirmation: { interactive: false, requireExplicit: false, yes: true },
        loaded,
        request: {},
      }),
    ).then((exit) => valueFromExit(exit));

    await expect(commit).rejects.toMatchObject(projectChanged);

    const current = await Effect.runPromiseExit(loadProject({ project: root })).then((exit) =>
      valueFromExit(exit),
    );

    expect(current.agents.map(({ id }) => id)).toEqual(['racer', 'support']);
  });
});
