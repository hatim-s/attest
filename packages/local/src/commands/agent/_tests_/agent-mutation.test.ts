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
      async (question) => {
        expect(question).toContain(expectedLine);
        await addAgent(root, agent(racer));

        return 'yes';
      };

    const add = runAgentAddCommand({
      interactive: true,
      project: root,
      prompt: addWhilePrompting('- add agent previewed', 'racer'),
      request: {
        schema: COMMAND_REQUEST_SCHEMA_ID,
        command: 'agent.add',
        agent: agent('previewed'),
      },
      workingDirectory: root,
    });

    await expect(add).rejects.toMatchObject(projectChanged);

    const remove = runAgentRemoveCommand({
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
    });

    await expect(remove).rejects.toMatchObject(projectChanged);

    const loaded = await loadProject({ project: root });
    expect(loaded.agents.map(({ id }) => id)).toEqual(['concurrent', 'racer', 'support']);
    expect(loaded.tests).toMatchObject([{ id: 'refund', agent_id: 'support' }]);
  });

  it('rejects a write that lands between loading the project and previewing the mutation', async () => {
    const root = await createAgentProject();
    const loaded = await loadCommandProject({ project: root, workingDirectory: root });
    const candidate = candidateFromLoadedProject(loaded);
    candidate.agents.push(agent('stale'));
    await addAgent(root, agent('racer'));

    const commit = mutationResult({
      candidate,
      command: 'agent.add',
      confirmation: { interactive: false, requireExplicit: false, yes: true },
      loaded,
      request: {},
    });

    await expect(commit).rejects.toMatchObject(projectChanged);
    const current = await loadProject({ project: root });
    expect(current.agents.map(({ id }) => id)).toEqual(['racer', 'support']);
  });
});
