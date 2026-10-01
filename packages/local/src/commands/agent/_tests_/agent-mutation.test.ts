import { COMMAND_REQUEST_SCHEMA_ID, type AgentResource } from '@attest/contracts';
import { describe, expect, it } from 'vitest';

import { loadProject } from '../../../project/index.js';
import type { Prompt } from '../../shared/prompt.js';
import { runAgentAddCommand } from '../add.js';
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
});
