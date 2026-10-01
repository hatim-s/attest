import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { COMMAND_REQUEST_SCHEMA_ID, type AgentResource } from '@attest/contracts';
import { onTestFinished } from 'vitest';

import { writeFixtureProject } from '../../../../_tests_/support/project-transaction.js';
import { runAgentAddCommand } from '../../add.js';

/** Writes the shared fixture project (agent `support`, test `refund`) into a removed-after-test directory. */
const createAgentProject = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'attest-local-agent-'));
  onTestFinished(() => rm(root, { force: true, recursive: true }));
  await writeFixtureProject(root);
  return root;
};

/** Adds one agent without prompting, as a non-interactive `agent add --from-json` would. */
const addAgent = async (root: string, agent: AgentResource): Promise<void> => {
  await runAgentAddCommand({
    interactive: false,
    project: root,
    request: { schema: COMMAND_REQUEST_SCHEMA_ID, command: 'agent.add', agent },
    workingDirectory: root,
  });
};

/** Reads every file below `root` as text, keyed by sorted relative path, for no-write checks. */
const snapshotFiles = async (root: string): Promise<Record<string, string>> => {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  const snapshot: Record<string, string> = {};
  for (const path of files) snapshot[path.slice(root.length + 1)] = await readFile(path, 'utf8');
  return snapshot;
};

export { addAgent, createAgentProject, snapshotFiles };
